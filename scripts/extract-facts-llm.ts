#!/usr/bin/env bun
// LLM-augmented fact + entity extraction. Replaces the heuristic v2.5
// extractor with a structured-prompt LLM (Ollama by default, Anthropic /
// OpenAI as fallback).
//
// Quality target: <5% noise vs the heuristic's ~30%. Conservative prompt
// rejects vague claims, generic predicates, and entity fragments.
//
// Idempotent: facts are deduped by (subject, predicate, object, episode);
// entities are deduped by name.
//
// Usage:
//   # Default (Ollama on localhost:11434, model llama3.1:8b):
//   bun scripts/extract-facts-llm.ts --owner ardin
//
//   # Pick a specific Ollama model:
//   OLLAMA_MODEL=qwen2.5:7b bun scripts/extract-facts-llm.ts --owner ardin
//
//   # Force a cloud provider:
//   MEMA_EXTRACTOR=anthropic bun scripts/extract-facts-llm.ts --owner ardin
//
//   # Limit how many episodes to process (for testing):
//   bun scripts/extract-facts-llm.ts --owner ardin --limit 10
//
//   # Dry-run (no writes):
//   bun scripts/extract-facts-llm.ts --owner ardin --dry-run

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { pickExtractor } from "../src/v2/llm-extractor";

interface Args {
  vault: string; api: string; key: string; owner: string;
  dryRun: boolean; limit: number;
  // v2.7+ acceptance lifecycle. Default `true` — LLM-extracted facts are
  // proposed as drafts and must be reviewed (or auto-approved by the
  // review CLI) before they surface in retrieval. Pass `--commit-direct`
  // to opt out and write approved records directly (legacy behavior).
  commitDirect: boolean;
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
    dryRun: !!flags["dry-run"],
    limit: flags.limit ? Number(flags.limit) : Infinity,
    commitDirect: !!flags["commit-direct"],
  };
}

// v2.7+ extract a short verbatim excerpt from the source episode that
// best evidences the (subject, predicate, object) claim. Prefers a
// sentence containing both subject and object; falls back to first
// sentence containing subject only. Truncated to 500 chars.
function pickEvidenceExcerpt(
  episodeBody: string,
  subject: string,
  object: string,
): string | undefined {
  const text = episodeBody.trim();
  if (!text) return undefined;
  const s = subject.trim().toLowerCase();
  const o = object.trim().toLowerCase();
  // Sentence split — naive but adequate for evidence excerpts.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  let bestBoth: string | undefined;
  let bestSubj: string | undefined;
  for (const sent of sentences) {
    const lower = sent.toLowerCase();
    if (lower.includes(s) && lower.includes(o)) { bestBoth = sent; break; }
    if (lower.includes(s) && !bestSubj) bestSubj = sent;
  }
  const picked = bestBoth ?? bestSubj;
  if (!picked) return undefined;
  return picked.length > 500 ? picked.slice(0, 497) + "..." : picked;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (e.endsWith(".md")) out.push(full);
    } catch { /* */ }
  }
  return out;
}

async function api(args: Args, path: string, body: any): Promise<any> {
  const r = await fetch(`${args.api}${path}`, {
    method: "POST",
    headers: { "x-api-key": args.key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Build a set of (subject|predicate|object|episode_id) tuples already in
// the vault so re-runs skip them.
function loadFactDedup(vault: string, owner: string): Set<string> {
  const seen = new Set<string>();
  const dir = join(vault, "facts", owner);
  if (!existsSync(dir)) return seen;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
      for (const epId of (fm.derived_from ?? []) as string[]) {
        seen.add(`${fm.subject}|${fm.predicate}|${fm.object}|${epId}`);
      }
    } catch { /* */ }
  }
  return seen;
}

function loadEntityDedup(vault: string, owner: string): Set<string> {
  const seen = new Set<string>();
  const dir = join(vault, "v2-entities", owner);
  if (!existsSync(dir)) return seen;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
      if (fm.name) seen.add(String(fm.name).toLowerCase());
    } catch { /* */ }
  }
  return seen;
}

async function main() {
  const args = parseArgs();
  console.log(`Vault: ${args.vault}`);
  console.log(`Owner: ${args.owner}`);
  console.log(`Mode:  ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log(`Gate:  ${args.commitDirect ? "commit-direct (legacy)" : "draft (review required)"}`);
  console.log("");

  const extractor = await pickExtractor();
  console.log(`Extractor: ${extractor.name}`);
  console.log("");

  const seenFacts = loadFactDedup(args.vault, args.owner);
  const seenEntities = loadEntityDedup(args.vault, args.owner);
  console.log(`Existing facts (for dedup):    ${seenFacts.size}`);
  console.log(`Existing entities (for dedup): ${seenEntities.size}`);

  const epFiles = walk(join(args.vault, "episodes", args.owner));
  const toProcess = epFiles.slice(0, args.limit);
  console.log(`Processing ${toProcess.length} of ${epFiles.length} episodes...`);
  console.log("");

  let factsCreated = 0, factsSkipped = 0;
  let entitiesCreated = 0, entitiesSkipped = 0;
  let llmCalls = 0, llmFailures = 0;
  const t0 = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const path = toProcess[i];
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;
    const epId = parsed.data.id as string;
    const body = parsed.content.trim();
    if (body.length < 200) continue;   // skip tiny stubs

    process.stdout.write(`  [${i + 1}/${toProcess.length}] ${epId.slice(-8)} ... `);

    let result;
    try {
      result = await extractor.extract(body);
      llmCalls++;
    } catch (e: any) {
      llmFailures++;
      process.stdout.write(`✗ LLM error: ${e.message.slice(0, 80)}\n`);
      continue;
    }

    let facts = 0, ents = 0;

    // v2.7+: untrusted-producer lifecycle. Default behavior writes drafts;
    // --commit-direct preserves the legacy direct-commit path.
    const status: "draft" | "approved" = args.commitDirect ? "approved" : "draft";
    const proposedBy = args.commitDirect ? undefined : `llm-extractor:${extractor.name}`;

    // Write entities first so facts can reference them
    for (const e of result.entities) {
      const name = String(e.name ?? "").trim();
      if (name.length < 2 || name.length > 80) continue;
      if (seenEntities.has(name.toLowerCase())) continue;
      seenEntities.add(name.toLowerCase());
      if (args.dryRun) { ents++; entitiesCreated++; continue; }
      try {
        const entityExcerpt = pickEvidenceExcerpt(body, name, "");
        await api(args, "/v2/entity", {
          name,
          type: String(e.type ?? "concept"),
          aliases: [],
          status,
          ...(proposedBy ? { proposed_by: proposedBy } : {}),
          ...(entityExcerpt ? { evidence_excerpt: entityExcerpt } : {}),
          derived_from: [epId],
        });
        ents++; entitiesCreated++;
      } catch { /* skip on collision */ }
    }

    for (const f of result.facts) {
      const subj = String(f.subject ?? "").trim();
      const pred = String(f.predicate ?? "").trim();
      const obj  = String(f.object ?? "").trim();
      const conf = Number(f.confidence ?? 0);
      if (!subj || !pred || !obj || conf < 0.75) continue;
      const tuple = `${subj}|${pred}|${obj}|${epId}`;
      if (seenFacts.has(tuple)) { factsSkipped++; continue; }
      seenFacts.add(tuple);
      if (args.dryRun) { facts++; factsCreated++; continue; }
      try {
        const excerpt = pickEvidenceExcerpt(body, subj, obj);
        await api(args, "/v2/fact", {
          subject: subj, predicate: pred, object: obj,
          derived_from: [epId],
          confidence: Math.min(Math.max(conf, 0), 1),
          status,
          ...(proposedBy ? { proposed_by: proposedBy } : {}),
          ...(excerpt ? { evidence_excerpt: excerpt } : {}),
        });
        facts++; factsCreated++;
      } catch { /* skip on failure */ }
    }

    process.stdout.write(`+${facts}F +${ents}E\n`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`Done in ${elapsed}s`);
  console.log(`  LLM calls:        ${llmCalls}  (failures: ${llmFailures})`);
  console.log(`  Facts created:    ${factsCreated}  (skipped: ${factsSkipped})`);
  console.log(`  Entities created: ${entitiesCreated}  (skipped: ${entitiesSkipped})`);
  console.log("");
  console.log("Next steps:");
  if (!args.commitDirect && !args.dryRun) {
    console.log("  - bun scripts/review-proposals.ts --owner " + args.owner + " --auto   (auto-approve high-confidence drafts with evidence)");
    console.log("  - bun scripts/review-proposals.ts --owner " + args.owner + "          (interactive review of remaining drafts)");
  }
  console.log("  - bun scripts/wire-entity-graph.ts   (link approved facts/entities to episodes)");
  console.log("  - bun scripts/fix-graph-connectivity.ts   (unfold any folded wikilinks)");
  console.log("  - curl -X POST http://localhost:3001/v2/vector/reindex -H 'x-api-key: dev-ardin'");
  console.log("  - Cmd+Q + reopen Obsidian to see the cleaner graph");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
