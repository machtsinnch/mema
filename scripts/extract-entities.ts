#!/usr/bin/env bun
// Heuristic entity extraction. Walks v2 episodes for an owner, collects
// capitalized-phrase candidates (people, organizations, concepts), keeps
// the ones that appear in N≥2 distinct episodes, creates v2-entities.
//
// No LLM call — preserves the no-LLM-on-write principle. Quality is modest
// but covers the high-frequency entities in a real corpus. Quality improves
// with LLM extraction (v2.6).
//
// Idempotent: skips entities whose name already exists for the owner.
//
// Usage:
//   bun scripts/extract-entities.ts --owner ardin [--dry-run] [--min-support 2]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface Args {
  vault: string; api: string; key: string; owner: string;
  minSupport: number; dryRun: boolean;
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
    minSupport: Number(flags["min-support"] ?? 2),
    dryRun: !!flags["dry-run"],
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    try {
      const st = require("node:fs").statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (e.endsWith(".md")) out.push(full);
    } catch { /* skip */ }
  }
  return out;
}

// Two complementary patterns:
//   - Multi-word capitalized phrases (Marcel R., Azure Cloud Foundation, US LLC)
//   - Acronyms (AKS, VAVGS, NCCE, MRR, S3, K8s)
const CAP_PHRASE = /\b([A-ZÄÖÜ][\wäöü]+(?:[ -][A-ZÄÖÜ0-9][\wäöü0-9]+){1,3})\b/g;
const ACRONYM = /\b([A-Z]{2,}[0-9]*[a-z]?)\b/g;

const STOPWORDS_PHRASE = new Set([
  "The", "This", "That", "These", "Those", "When", "Where", "Who", "Why",
  "What", "How", "And", "Or", "But", "For", "With", "About", "After",
  "Before", "Between", "During", "Through", "Within", "Without", "Round",
  "Status", "Date", "Owner", "Classification", "Basis", "Note", "Notes",
  "Document", "Section", "Source", "Header", "Footer", "Summary", "Index",
  "Both", "Also", "Even", "Just", "Only", "Still", "Each", "Every", "Any",
  "First", "Last", "Next", "Previous", "All", "None", "Some", "More",
  // Common prose words that often appear capitalized (sentence start)
  "Approach", "Result", "Decision", "Action", "Plan", "Issue", "Problem",
  "Goal", "Reason", "Cause", "Effect", "Impact", "Risk", "Benefit",
  "Cost", "Price", "Value", "Time", "Date", "Year", "Month", "Day",
  "Property", "Method", "Function", "System", "Service", "Platform",
  "Feature", "Component", "Module", "Project", "Product", "Customer",
  "Client", "User", "Team", "Member", "Role", "Phase", "Stage", "Step",
  "Tier", "Level", "Type", "Kind", "Form", "Way", "Path", "Route",
  "True", "False", "Yes", "No", "OK", "Okay", "Sure", "Maybe",
  "Source", "Target", "Input", "Output", "Request", "Response",
  // SQL / emphasis / structural-document keywords (frequent false positives)
  "IF", "WHEN", "WHERE", "AND", "OR", "NOT", "IN", "ON", "AS", "BY", "FROM",
  "WITH", "WHY", "WHAT", "HOW", "YES", "NO", "OK", "TRUE", "FALSE",
  "MAXIMUM", "MINIMUM", "MAX", "MIN", "ALL", "NONE", "MUST", "SHOULD",
  "TODO", "FIXME", "XXX", "NOTE", "WARN", "INFO", "DEBUG", "ERROR",
  "NULL", "UNDEFINED", "VOID",
]);

// Reject phrases that are a single word AND a common English/German prose
// noun/adjective. Multi-word phrases and acronyms pass through.
const PROSE_NOUN = /^[A-Z][a-z]{2,15}$/;

function isLikelyEntity(name: string): boolean {
  if (STOPWORDS_PHRASE.has(name)) return false;
  // Multi-word? Most are real entities.
  if (/\s|-/.test(name)) return true;
  // Acronym?
  if (/^[A-Z]{2,}[0-9]*[a-z]?$/.test(name)) return true;
  // Capitalized number+letter? (e.g. "S3")
  if (/^[A-Z][0-9]+[a-z]?$/.test(name)) return true;
  // Otherwise: looks like prose. Reject.
  return false;
}

// Guess entity type from name shape.
function guessType(name: string): string {
  if (/^[A-Z][a-z]+\s+[A-Z]\.?\s*$/.test(name)) return "person";
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(name)) return "person";
  if (/AG|GmbH|Inc|Ltd|Corp|LLC|SA\b/i.test(name)) return "organization";
  if (/^[A-Z]{2,}$/.test(name)) return "concept";
  if (/[0-9]/.test(name)) return "concept";
  return "concept";
}

async function entityExists(args: Args, name: string): Promise<boolean> {
  const enc = encodeURIComponent(name);
  const r = await fetch(`${args.api}/v2/entity/find/${enc}`, {
    headers: { "x-api-key": args.key },
  });
  return r.ok;
}

async function createEntity(args: Args, name: string, type: string): Promise<string | null> {
  if (args.dryRun) return "dry-run-id";
  const r = await fetch(`${args.api}/v2/entity`, {
    method: "POST",
    headers: { "x-api-key": args.key, "content-type": "application/json" },
    body: JSON.stringify({ name, type, aliases: [] }),
  });
  if (!r.ok) { console.error(`  ✗ ${name}: ${r.status}`); return null; }
  const d = await r.json() as { entity: { id: string } };
  return d.entity.id;
}

async function main() {
  const args = parseArgs();
  console.log(`Vault:        ${args.vault}`);
  console.log(`Owner:        ${args.owner}`);
  console.log(`Min support:  ${args.minSupport}`);
  console.log(`Mode:         ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log("");

  // ── Walk episodes, collect entity candidates ──────────────────────
  const epDir = join(args.vault, "episodes", args.owner);
  const files = walk(epDir);
  console.log(`Scanning ${files.length} episodes...`);

  const mentionCount = new Map<string, { count: number; episodes: Set<string> }>();
  for (const path of files) {
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;
    const epId = parsed.data.id as string;
    const text = parsed.content;
    const seenInEpisode = new Set<string>();
    for (const m of text.matchAll(CAP_PHRASE)) {
      const phrase = m[1].trim();
      if (phrase.length < 3 || phrase.length > 60) continue;
      if (!isLikelyEntity(phrase)) continue;
      seenInEpisode.add(phrase);
    }
    for (const m of text.matchAll(ACRONYM)) {
      const acro = m[1].trim();
      if (acro.length < 2 || acro.length > 12) continue;
      if (!isLikelyEntity(acro)) continue;
      seenInEpisode.add(acro);
    }
    for (const phrase of seenInEpisode) {
      const entry = mentionCount.get(phrase) ?? { count: 0, episodes: new Set() };
      entry.count++;
      entry.episodes.add(epId);
      mentionCount.set(phrase, entry);
    }
  }

  const candidates = [...mentionCount.entries()]
    .filter(([, info]) => info.episodes.size >= args.minSupport)
    .sort((a, b) => b[1].episodes.size - a[1].episodes.size);

  console.log(`Candidates: ${candidates.length} entities mentioned in ≥${args.minSupport} episodes`);
  console.log("");

  // ── Create entities ──────────────────────────────────────────────
  let created = 0, skipped = 0, failed = 0;
  for (const [name, info] of candidates) {
    const exists = await entityExists(args, name);
    if (exists) { skipped++; continue; }
    const type = guessType(name);
    if (args.dryRun) {
      console.log(`  [dry-run] ${type.padEnd(13)} ${name}  (${info.episodes.size} eps)`);
      created++;
      continue;
    }
    const id = await createEntity(args, name, type);
    if (id) {
      console.log(`  ✓ ${type.padEnd(13)} ${name}  → ${id}  (${info.episodes.size} eps)`);
      created++;
    } else {
      failed++;
    }
  }

  console.log("");
  console.log(`Created: ${created}, Skipped (already exists): ${skipped}, Failed: ${failed}`);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
