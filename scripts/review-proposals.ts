#!/usr/bin/env bun
// Acceptance gate for LLM-proposed facts and entities (v2.7+).
//
// Workflow:
//   1. `extract-facts-llm.ts` writes draft facts/entities (status: "draft")
//   2. This script walks those drafts and either:
//      - --auto mode: auto-approves records where confidence ≥ 0.9 AND the
//        evidence-check guard passes (subject+object substrings appear in
//        the source episode body). Rejects records whose evidence check
//        fails. Leaves borderline-confidence records for human review.
//      - default (interactive): prints each draft with the source episode
//        excerpt and prompts a/r/s (approve/reject/skip).
//
// Both modes hit the same /v2/fact/:id/approve and /v2/fact/:id/reject
// endpoints, which run an evidence check server-side and append an
// audit-chain entry for every state transition.
//
// Usage:
//   bun scripts/review-proposals.ts --owner ardin --auto
//   bun scripts/review-proposals.ts --owner ardin              (interactive)
//   bun scripts/review-proposals.ts --owner ardin --dry-run    (no writes)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface Args {
  vault: string; api: string; key: string; owner: string;
  auto: boolean; dryRun: boolean; limit: number;
  // Confidence floor for auto-approve when evidence passes. Below this,
  // records are left as drafts for human review.
  autoApproveThreshold: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[k] = next; i++; }
    else flags[k] = true;
  }
  return {
    vault: String(flags.vault ?? `${process.env.HOME}/Projects/machtsinn.ai/data`),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    owner: String(flags.owner ?? "ardin"),
    auto: !!flags.auto,
    dryRun: !!flags["dry-run"],
    limit: flags.limit ? Number(flags.limit) : Infinity,
    autoApproveThreshold: flags.threshold ? Number(flags.threshold) : 0.9,
  };
}

async function api(args: Args, method: "GET" | "POST", path: string, body?: any): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`${args.api}${path}`, {
    method,
    headers: {
      "x-api-key": args.key,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

// Substring evidence check (mirrors the server's evidenceCheck for previewing
// outcomes before sending the approve request).
function clientEvidenceCheck(subject: string, object: string, body: string): { ok: boolean; missing: string[] } {
  const haystack = body.toLowerCase();
  const missing: string[] = [];
  if (subject && !haystack.includes(subject.toLowerCase())) missing.push("subject");
  if (object && !haystack.includes(object.toLowerCase())) missing.push("object");
  return { ok: missing.length === 0, missing };
}

interface DraftFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  derived_from: string[];
  evidence_excerpt?: string;
  proposed_by?: string;
}

function loadDraftFacts(vault: string, owner: string): DraftFact[] {
  const dir = join(vault, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: DraftFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
      if (fm.status !== "draft") continue;
      out.push({
        id: fm.id,
        subject: fm.subject,
        predicate: fm.predicate,
        object: fm.object,
        confidence: Number(fm.confidence ?? 0),
        derived_from: (fm.derived_from ?? []) as string[],
        evidence_excerpt: fm.evidence_excerpt,
        proposed_by: fm.proposed_by,
      });
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function loadEpisodeBody(vault: string, owner: string, episodeId: string): string | null {
  const dir = join(vault, "episodes", owner);
  if (!existsSync(dir)) return null;
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith(".md")) out.push(full);
    }
    return out;
  };
  for (const p of walk(dir)) {
    try {
      const parsed = matter(readFileSync(p, "utf8"));
      if (parsed.data.id === episodeId) return parsed.content.trim();
    } catch { /* skip malformed */ }
  }
  return null;
}

async function autoMode(args: Args, drafts: DraftFact[]): Promise<void> {
  let approved = 0, rejectedNoEvidence = 0, leftForReview = 0;
  for (const d of drafts) {
    const epBody = d.derived_from[0] ? loadEpisodeBody(args.vault, args.owner, d.derived_from[0]) : null;
    const evidence = epBody ? clientEvidenceCheck(d.subject, d.object, epBody) : { ok: false, missing: ["episode_not_found"] };

    if (!evidence.ok) {
      const reason = `auto-reject: evidence check failed (missing: ${evidence.missing.join(",")})`;
      console.log(`  REJECT ${d.id.slice(-8)}  ${d.subject} ${d.predicate} ${d.object}  — ${reason}`);
      if (!args.dryRun) {
        await api(args, "POST", `/v2/fact/${d.id}/reject`, { reason });
      }
      rejectedNoEvidence++;
      continue;
    }

    if (d.confidence >= args.autoApproveThreshold) {
      const reason = `auto-approve: confidence=${d.confidence.toFixed(2)} + evidence_ok`;
      console.log(`  APPROVE ${d.id.slice(-8)} ${d.subject} ${d.predicate} ${d.object}  — ${reason}`);
      if (!args.dryRun) {
        await api(args, "POST", `/v2/fact/${d.id}/approve`, { reason });
      }
      approved++;
    } else {
      console.log(`  HOLD    ${d.id.slice(-8)} ${d.subject} ${d.predicate} ${d.object}  — confidence=${d.confidence.toFixed(2)} below ${args.autoApproveThreshold}`);
      leftForReview++;
    }
  }
  console.log("");
  console.log(`Auto-mode summary (owner=${args.owner}):`);
  console.log(`  approved:              ${approved}`);
  console.log(`  rejected (no evidence): ${rejectedNoEvidence}`);
  console.log(`  held for human review:  ${leftForReview}`);
}

async function interactiveMode(args: Args, drafts: DraftFact[]): Promise<void> {
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let approved = 0, rejected = 0, skipped = 0;

  const ask = (prompt: string): Promise<string> => new Promise(resolve => {
    process.stdout.write(prompt);
    const onData = (chunk: string) => {
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(chunk.trim());
    };
    stdin.resume();
    stdin.once("data", onData);
  });

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const epBody = d.derived_from[0] ? loadEpisodeBody(args.vault, args.owner, d.derived_from[0]) : null;
    const evidence = epBody ? clientEvidenceCheck(d.subject, d.object, epBody) : { ok: false, missing: ["episode_not_found"] };
    console.log("");
    console.log(`── [${i + 1}/${drafts.length}] ${d.subject} ${d.predicate} ${d.object} ──`);
    console.log(`   confidence: ${d.confidence.toFixed(2)}  | proposed_by: ${d.proposed_by ?? "?"}`);
    console.log(`   evidence:   ${evidence.ok ? "✓ ok" : "✗ missing " + evidence.missing.join(",")}`);
    if (d.evidence_excerpt) {
      console.log(`   excerpt:    "${d.evidence_excerpt.slice(0, 200)}${d.evidence_excerpt.length > 200 ? "…" : ""}"`);
    }
    const ans = (await ask("   a=approve  r=reject  s=skip  q=quit ? ")).toLowerCase();
    if (ans === "q") break;
    if (ans === "a") {
      if (!args.dryRun) await api(args, "POST", `/v2/fact/${d.id}/approve`, { reason: "human-approved" });
      approved++;
    } else if (ans === "r") {
      const reason = (await ask("   reject reason: ")).trim() || "human-rejected";
      if (!args.dryRun) await api(args, "POST", `/v2/fact/${d.id}/reject`, { reason });
      rejected++;
    } else {
      skipped++;
    }
  }
  console.log("");
  console.log(`Interactive summary (owner=${args.owner}):`);
  console.log(`  approved: ${approved}  rejected: ${rejected}  skipped: ${skipped}`);
}

async function main() {
  const args = parseArgs();
  console.log(`Vault:     ${args.vault}`);
  console.log(`Owner:     ${args.owner}`);
  console.log(`Mode:      ${args.auto ? "auto" : "interactive"}${args.dryRun ? " (dry-run)" : ""}`);
  if (args.auto) console.log(`Threshold: ${args.autoApproveThreshold}`);
  console.log("");

  const drafts = loadDraftFacts(args.vault, args.owner).slice(0, args.limit);
  if (drafts.length === 0) {
    console.log("No draft facts to review.");
    return;
  }
  console.log(`Reviewing ${drafts.length} draft fact(s).`);

  if (args.auto) await autoMode(args, drafts);
  else await interactiveMode(args, drafts);
}

main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
