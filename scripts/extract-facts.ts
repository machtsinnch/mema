#!/usr/bin/env bun
// Heuristic fact extraction. Scans episodes for sentences where two
// already-extracted entities co-occur AND an explicit predicate keyword
// appears between them. Emits S-P-O facts via /v2/fact with derived_from
// pointing at the source episode.
//
// No LLM call. Quality is conservative: we'd rather miss facts than
// generate noise. The patterns target deployment / architecture / decision
// language common in technical content.
//
// Idempotent: skips facts whose (subject, predicate, object, derived_from)
// tuple already exists for the owner.
//
// Usage: bun scripts/extract-facts.ts --owner ardin [--dry-run]

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface Args { vault: string; api: string; key: string; owner: string; dryRun: boolean; }

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
  };
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

// Predicate keywords. Each maps `<entity> <kw> <entity>` to a fact predicate.
// Conservative: only STRONG verbs that imply a clear semantic relationship.
// Weak predicates ("is", "at") were dropped — they generated more noise than
// signal in technical content where CHF/EUR/USD-style currency entities co-
// occur on every line.
const PREDICATES: { match: RegExp; predicate: string }[] = [
  { match: /\bfounded\b/i,                predicate: "founded" },
  { match: /\bowns?\b/i,                  predicate: "owns" },
  { match: /\buses?\b/i,                  predicate: "uses" },
  { match: /\bchose\b|\bchosen for\b/i,   predicate: "chose" },
  { match: /\brejected\b|\bdropped\b/i,   predicate: "rejected" },
  { match: /\breplaces?\b|\bsupersedes?\b/i, predicate: "supersedes" },
  { match: /\bdepends? on\b|\brequires?\b/i, predicate: "depends_on" },
  { match: /\bintegrates? with\b/i,       predicate: "integrates_with" },
  { match: /\bdeploys? to\b|\bruns? on\b/i, predicate: "deploys_to" },
  { match: /\bmanages\b/i,                predicate: "manages" },
  { match: /\bsupports\b/i,               predicate: "supports" },
  { match: /\bbuilt on\b|\bbuilt with\b/i, predicate: "built_on" },
  { match: /\bextends\b|\bextending\b/i,   predicate: "extends" },
  { match: /\bcalls\b|\binvokes\b/i,       predicate: "calls" },
  { match: /\bconnects? to\b/i,            predicate: "connects_to" },
];

async function api(args: Args, method: "GET" | "POST", path: string, body?: any): Promise<any> {
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers: { "x-api-key": args.key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function loadEntities(args: Args): Promise<Set<string>> {
  // Pull the owner's entity list. Use direct filesystem read for speed
  // (the /v2/entities endpoint reloads frontmatter for each).
  const dir = join(args.vault, "v2-entities", args.owner);
  const names = new Set<string>();
  if (!existsSync(dir)) return names;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
      if (fm.name) names.add(fm.name as string);
      for (const a of (fm.aliases ?? []) as string[]) names.add(a);
    } catch { /* skip */ }
  }
  return names;
}

// Find pairs of entities co-occurring in the same sentence, with a predicate
// keyword somewhere between them.
function extractFromSentence(
  sentence: string,
  entities: Set<string>,
): Array<{ subject: string; predicate: string; object: string }> {
  const out: Array<{ subject: string; predicate: string; object: string }> = [];
  // Find entity occurrences with positions
  const occurrences: { name: string; pos: number }[] = [];
  for (const e of entities) {
    if (e.length < 3) continue;
    const re = new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let m;
    while ((m = re.exec(sentence)) !== null) {
      occurrences.push({ name: e, pos: m.index });
      if (occurrences.length > 12) break;
    }
  }
  occurrences.sort((a, b) => a.pos - b.pos);

  // For each adjacent pair, look for a predicate keyword in the text between them
  for (let i = 0; i < occurrences.length - 1; i++) {
    const a = occurrences[i];
    const b = occurrences[i + 1];
    if (a.name === b.name) continue;
    const between = sentence.slice(a.pos + a.name.length, b.pos);
    // Reject if too far apart (likely unrelated)
    if (between.length > 80) continue;
    for (const { match, predicate } of PREDICATES) {
      if (match.test(between)) {
        out.push({ subject: a.name, predicate, object: b.name });
        break;
      }
    }
  }
  return out;
}

async function factExists(args: Args, fact: { subject: string; predicate: string; object: string }, epId: string): Promise<boolean> {
  const dir = join(args.vault, "facts", args.owner);
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
      if (fm.subject === fact.subject && fm.predicate === fact.predicate && fm.object === fact.object) {
        if ((fm.derived_from as string[] ?? []).includes(epId)) return true;
      }
    } catch { /* */ }
  }
  return false;
}

async function main() {
  const args = parseArgs();
  console.log(`Vault:  ${args.vault}`);
  console.log(`Owner:  ${args.owner}`);
  console.log(`Mode:   ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log("");

  const entities = await loadEntities(args);
  console.log(`Loaded ${entities.size} entities (names + aliases) for matching`);

  const files = walk(join(args.vault, "episodes", args.owner));
  console.log(`Scanning ${files.length} episodes...`);
  console.log("");

  let scanned = 0, found = 0, created = 0, skipped = 0, failed = 0;
  const seenTuples = new Set<string>();

  for (const path of files) {
    scanned++;
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;
    const epId = parsed.data.id as string;
    const text = parsed.content;
    const sentences = text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 400);
    for (const s of sentences) {
      const facts = extractFromSentence(s, entities);
      for (const fact of facts) {
        const tuple = `${fact.subject}::${fact.predicate}::${fact.object}::${epId}`;
        if (seenTuples.has(tuple)) continue;
        seenTuples.add(tuple);
        found++;
        if (await factExists(args, fact, epId)) { skipped++; continue; }
        if (args.dryRun) {
          if (created < 30) console.log(`  [dry-run] ${fact.subject} -${fact.predicate}-> ${fact.object}`);
          created++;
          continue;
        }
        try {
          await api(args, "POST", "/v2/fact", {
            ...fact,
            derived_from: [epId],
            confidence: 0.6,
          });
          created++;
          if (created % 50 === 0) process.stdout.write(`  …${created} facts created\n`);
        } catch (e: any) {
          failed++;
          if (failed < 5) console.error(`  ✗ ${fact.subject} -${fact.predicate}-> ${fact.object}: ${e.message}`);
        }
      }
    }
  }

  console.log("");
  console.log(`Scanned episodes: ${scanned}`);
  console.log(`Unique fact tuples found: ${found}`);
  console.log(`Created: ${created}, Skipped (already exist): ${skipped}, Failed: ${failed}`);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
