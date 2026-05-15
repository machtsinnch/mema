#!/usr/bin/env bun
// Wire the entity graph so Obsidian renders proper edges between layers:
//
//   Entity  --links-->  every Episode that mentions its name
//   Fact    --links-->  Subject entity + Object entity (in addition to its
//                       existing derived_from episodes)
//
// Without this pass, v2 entities float disconnected in the Obsidian graph
// (they're created with empty `links:`), and facts only show edges to their
// source episodes, not to the entities they describe. This script populates
// the Obsidian-graph link arrays without changing the canonical semantic
// fields (entity.name, fact.subject/predicate/object stay authoritative).
//
// Idempotent. Safe to re-run on every extraction round.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";

interface Args { vault: string; owner: string; dryRun: boolean; }

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

interface EpisodeIndex { id: string; filename: string; content: string; path: string; }
interface EntityIndex { id: string; name: string; aliases: string[]; filename: string; path: string; }

async function main() {
  const args = parseArgs();
  console.log(`Vault: ${args.vault}`);
  console.log(`Owner: ${args.owner}`);
  console.log(`Mode:  ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log("");

  // ── Index entities ──────────────────────────────────────────────
  const entityDir = join(args.vault, "v2-entities", args.owner);
  const entities: EntityIndex[] = [];
  const entityByName = new Map<string, EntityIndex>();   // name (lowercase) → entity
  for (const path of walk(entityDir)) {
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;
    const ent: EntityIndex = {
      id: parsed.data.id as string,
      name: parsed.data.name as string,
      aliases: ((parsed.data.aliases ?? []) as string[]),
      filename: basename(path, ".md"),
      path,
    };
    entities.push(ent);
    entityByName.set(ent.name.toLowerCase(), ent);
    for (const a of ent.aliases) entityByName.set(a.toLowerCase(), ent);
  }
  console.log(`Entities: ${entities.length}`);

  // ── Index episodes ──────────────────────────────────────────────
  const epDir = join(args.vault, "episodes", args.owner);
  const episodes: EpisodeIndex[] = [];
  for (const path of walk(epDir)) {
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;
    episodes.push({
      id: parsed.data.id as string,
      filename: basename(path, ".md"),
      content: parsed.content,
      path,
    });
  }
  console.log(`Episodes: ${episodes.length}`);
  console.log("");

  // ── Pass A: entity --links--> episodes that mention it ──────────
  console.log("Pass A: wiring entity → episode edges...");
  let entitiesUpdated = 0;
  for (const ent of entities) {
    // Find episodes mentioning this entity (case-insensitive whole-word)
    const re = new RegExp(`\\b${ent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const mentions: EpisodeIndex[] = [];
    for (const ep of episodes) {
      if (re.test(ep.content)) mentions.push(ep);
    }
    if (mentions.length === 0) continue;

    const newLinks = mentions.map(ep => `[[${ep.filename}]]`);
    const newDerivedFrom = mentions.map(ep => ep.id);

    const parsed = matter(readFileSync(ent.path, "utf8"));
    const existingLinks = (parsed.data.links ?? []) as string[];
    const mergedLinks = [...new Set([...existingLinks, ...newLinks])];
    if (mergedLinks.length === existingLinks.length) continue;     // no change
    parsed.data.links = mergedLinks;
    parsed.data.mentioned_in = newDerivedFrom;
    for (const k of Object.keys(parsed.data)) {
      if (parsed.data[k] === undefined) delete parsed.data[k];
    }
    if (!args.dryRun) {
      writeFileSync(ent.path, matter.stringify(parsed.content.trim(), parsed.data), "utf8");
    }
    entitiesUpdated++;
  }
  console.log(`  ${entitiesUpdated} entity files updated with mention links`);
  console.log("");

  // ── Pass B: fact --links--> subject + object entities ───────────
  console.log("Pass B: wiring fact → entity edges...");
  const factDir = join(args.vault, "facts", args.owner);
  let factsUpdated = 0;
  for (const path of walk(factDir)) {
    let parsed;
    try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
    if (parsed.data.owner !== args.owner) continue;
    if (parsed.data.tombstone === true) continue;

    const subj = (parsed.data.subject as string | undefined) ?? "";
    const obj = (parsed.data.object as string | undefined) ?? "";
    const subjEnt = entityByName.get(subj.toLowerCase());
    const objEnt = entityByName.get(obj.toLowerCase());

    const newLinks: string[] = [];
    if (subjEnt) newLinks.push(`[[${subjEnt.filename}]]`);
    if (objEnt && objEnt.filename !== subjEnt?.filename) newLinks.push(`[[${objEnt.filename}]]`);
    if (newLinks.length === 0) continue;

    const existingLinks = (parsed.data.links ?? []) as string[];
    const mergedLinks = [...new Set([...existingLinks, ...newLinks])];
    if (mergedLinks.length === existingLinks.length) continue;
    parsed.data.links = mergedLinks;
    for (const k of Object.keys(parsed.data)) {
      if (parsed.data[k] === undefined) delete parsed.data[k];
    }
    if (!args.dryRun) {
      writeFileSync(path, matter.stringify(parsed.content.trim(), parsed.data), "utf8");
    }
    factsUpdated++;
  }
  console.log(`  ${factsUpdated} fact files updated with subject+object entity links`);
  console.log("");
  console.log("Done. Cmd+Q + reopen Obsidian to see the new edges in the graph.");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
