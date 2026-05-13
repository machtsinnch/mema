#!/usr/bin/env bun
// auto-link.ts — connect memories that share concepts WITHIN the same entity.
// Concepts are extracted from BODY content (not just filename), giving meaningful coupling.
//
// Algorithm:
//   1. For each memory, extract a concept set:
//      - All frontmatter tags
//      - Hyphenated technical terms (cosmos-db, multi-tenant)
//      - Proper-noun phrases mentioned 2+ times (Roche, Swiss Tax, Diamond Hands)
//      - Numeric/financial identifiers (ETF tickers in caps + digits)
//   2. Build entity-scoped inverse index: concept → memories mentioning it
//   3. For each pair within the same entity that shares N+ concepts, link them
//   4. PUT /v1/memory/:id with [[ULID]] wikilinks in `links` frontmatter

const API = process.env.MACHTSINN_URL ?? "http://localhost:3001";
const KEY = process.env.MACHTSINN_KEY ?? "dev-ardin";
const MIN_SHARED = Number(process.env.MIN_SHARED ?? 2);
const MAX_LINKS_PER_MEMORY = Number(process.env.MAX_LINKS ?? 10);

interface Memory {
  frontmatter: {
    id: string;
    scope: string;
    entity?: string;
    tags: string[];
    links: string[];
    aliases?: string[];
    forgotten?: boolean;
  };
  body: string;
  path: string;
}

const STOPWORDS = new Set([
  "the","and","for","with","that","this","from","have","has","are","was","were","will","would",
  "could","should","their","they","them","there","these","those","what","when","where","which",
  "while","about","into","over","than","also","then","such","very","much","most","some","more",
  "less","only","just","like","one","two","three","four","five","first","second","third","last",
  "main","new","old","high","low","big","small","good","bad","best","top","plan","plans","note",
  "notes","section","part","parts","step","steps","date","dates","time","types","type","point",
  "points","case","cases","detail","details","example","examples","summary","overview","framework",
  "context","content","contents","name","names","value","values","item","items","list","field",
  "header","page","line","table","tables","figure","year","years","month","months","day","days",
  "week","weeks","january","february","march","april","june","july","august","september","october",
  "november","december","support","required","reference","model","models","required","options",
  "interactive","starting","completed","provider","provides","returns","existing","available",
  "real-time","end-to-end","long-term","short-term","built-in","open-source","cost","costs",
  "price","prices","total","unit","units","using","user","users","agent","agents","tool","tools",
  "data","info","result","results","based","action","status","level","levels","change","changes",
  "single","quick","setup","record","records","file","files","source","target","content","contents",
  "rule","rules","spec","specs","plan","plans","input","output","memory","memories",
]);

async function api(method: "GET" | "POST" | "PUT", path: string, body?: any): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listAllMemories(): Promise<Memory[]> {
  const result = await api("GET", "/v1/list?scope=all&limit=10000&body=1");
  return result.memories;
}

function extractConcepts(m: Memory): Set<string> {
  const out = new Set<string>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

  // 1) Tags (already curated)
  for (const t of m.frontmatter.tags) {
    const n = norm(t);
    if (n.length >= 4 && !STOPWORDS.has(n)) out.add(n);
  }

  // 2) Hyphenated technical terms
  const hyph = (m.body.match(/\b[a-z][a-z]+(?:-[a-z][a-z0-9]+){1,3}\b/gi) ?? []).slice(0, 300);
  for (const h of hyph) {
    const n = norm(h);
    if (n.length >= 7 && !STOPWORDS.has(n)) out.add(n);
  }

  // 3) Proper-noun phrases mentioned 2+ times — count occurrences, keep frequent ones
  const properRegex = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b/g;
  const properCounts = new Map<string, number>();
  for (const m1 of (m.body.match(properRegex) ?? [])) {
    properCounts.set(m1, (properCounts.get(m1) ?? 0) + 1);
  }
  for (const [phrase, count] of properCounts) {
    if (count < 2) continue;
    const n = phrase.toLowerCase().replace(/\s+/g, "-");
    if (n.length >= 5 && n.length <= 40 && !STOPWORDS.has(n)) out.add(n);
  }

  // 4) Ticker-shaped uppercase identifiers (3-6 caps)
  for (const tk of (m.body.match(/\b[A-Z]{3,6}\b/g) ?? [])) {
    const n = tk.toLowerCase();
    if (!STOPWORDS.has(n)) out.add(n);
  }

  // 5) Aliases (first heading words)
  if (m.frontmatter.aliases) {
    for (const a of m.frontmatter.aliases) {
      for (const w of a.split(/\s+/)) {
        const n = norm(w);
        if (n.length >= 5 && !STOPWORDS.has(n)) out.add(n);
      }
    }
  }

  return out;
}

async function main() {
  console.log(`Scanning memories...`);
  const all = await listAllMemories();
  const byEntity = new Map<string, Memory[]>();
  for (const m of all) {
    if (m.frontmatter.forgotten) continue;
    if (m.frontmatter.scope !== "entity") continue;
    const e = m.frontmatter.entity!;
    const list = byEntity.get(e) ?? [];
    list.push(m);
    byEntity.set(e, list);
  }
  console.log(`Found ${all.length} memories across ${byEntity.size} entities.\n`);

  let totalLinksAdded = 0;
  let memoriesUpdated = 0;

  for (const [entity, memories] of byEntity) {
    console.log(`[${entity}] ${memories.length} memories — extracting concepts...`);
    const concepts = memories.map(extractConcepts);

    // Stat: concept set sizes
    const avgConcepts = concepts.reduce((a, b) => a + b.size, 0) / Math.max(memories.length, 1);
    console.log(`  avg concepts per memory: ${avgConcepts.toFixed(1)}`);

    // For each pair, count shared concepts
    const updates: Record<string, { id: string; score: number }[]> = {};
    for (let i = 0; i < memories.length; i++) {
      const peers: { id: string; score: number }[] = [];
      for (let j = 0; j < memories.length; j++) {
        if (i === j) continue;
        let shared = 0;
        for (const c of concepts[i]) if (concepts[j].has(c)) shared++;
        if (shared >= MIN_SHARED) peers.push({ id: memories[j].frontmatter.id, score: shared });
      }
      peers.sort((a, b) => b.score - a.score);
      const top = peers.slice(0, MAX_LINKS_PER_MEMORY);
      if (top.length > 0) updates[memories[i].frontmatter.id] = top;
    }

    let count = 0;
    for (const [id, peers] of Object.entries(updates)) {
      const links = peers.map(p => p.id);
      try {
        await api("PUT", `/v1/memory/${id}`, { actor: "auto-link-v2", links });
        totalLinksAdded += links.length;
        memoriesUpdated++;
        count++;
      } catch (e: any) {
        console.error(`  ✗ ${id}: ${e.message}`);
      }
    }
    console.log(`  → ${count} memories linked, ${Object.values(updates).reduce((a, b) => a + b.length, 0)} total wikilinks`);
  }

  console.log(`\nTotal: ${memoriesUpdated} memories updated, ${totalLinksAdded} wikilinks added.`);
}

main().catch(err => { console.error("fatal:", err.message); process.exit(1); });
