// machtsinn.ai — ripgrep-backed search across the vault.
// Returns all .md hits with frontmatter, body, and match line numbers.

import { $ } from "bun";
import { readMemoryFromPath } from "./storage";
import type { Memory } from "./types";

export interface RipgrepHit {
  memory: Memory;
  matches: { line: number; text: string }[];
}

interface RgMatchEvent {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: { match: { text: string }; start: number; end: number }[];
  };
}

export async function ripgrepSearch(vaultRoot: string, query: string): Promise<RipgrepHit[]> {
  if (!query.trim()) return [];

  // Tokenize: split query into whitespace-separated terms. Treat each term as an
  // independent ripgrep pattern (-e), so the search behaves like keyword-OR rather
  // than literal-phrase regex. Hyphenated terms (e.g. "Multi-tenant") stay intact.
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/^[^\w-]+|[^\w-]+$/g, "")) // trim leading/trailing punctuation
    .filter(t => t.length >= 2);

  if (tokens.length === 0) return [];

  const eFlags = tokens.flatMap(t => ["-e", t]);
  const result = await $`rg --json -i -g "*.md" ${eFlags} ${vaultRoot}`
    .nothrow()
    .quiet()
    .text();

  if (process.env.MACHTSINN_DEBUG === "1") {
    console.error(`[rg] query="${query}" tokens=${JSON.stringify(tokens)} root="${vaultRoot}" output_len=${result.length}`);
  }
  if (!result.trim()) return [];

  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const line of result.split("\n")) {
    if (!line) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== "match") continue;
    const e = evt as RgMatchEvent;
    const path = e.data.path.text;
    const entry = { line: e.data.line_number, text: e.data.lines.text.trim() };
    const arr = byPath.get(path) ?? [];
    arr.push(entry);
    byPath.set(path, arr);
  }

  const hits: RipgrepHit[] = [];
  for (const [path, matches] of byPath) {
    try {
      const memory = readMemoryFromPath(path);
      if (memory.frontmatter.forgotten) continue;
      hits.push({ memory, matches });
    } catch {
      // skip unreadable files
    }
  }
  return hits;
}
