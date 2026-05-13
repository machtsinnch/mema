// machtsinn.ai — HTTP API (Hono). Six-op surface + reads + stats.

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { ulid } from "ulid";
import {
  ensureVault,
  writeMemory,
  findMemoryById,
  walkVault,
  updateMemory,
  forgetMemory,
  canRead,
  getEntityHierarchy,
  fromWikilink,
  isReadable,
} from "./storage";
import { ripgrepSearch } from "./search";
import { scoreHits } from "./scoring";
import { logOp, queryLog } from "./db";
import type { RememberInput, RecallInput, ForgetInput, UpdateInput } from "./types";
import type { VaultConfig } from "./storage";

type AppEnv = {
  Variables: {
    owner: string;
    actor: string;
  };
};

export function buildApi(cfg: { vaultRoot: string; apiKeys: Record<string, string> }) {
  const vault: VaultConfig = { root: cfg.vaultRoot };
  ensureVault(vault);

  const app = new Hono<AppEnv>();
  app.use("*", logger());
  // CORS: locked down by default. Override with MACHTSINN_CORS_ORIGINS (CSV of allowed origins).
  const corsOrigins = (process.env.MACHTSINN_CORS_ORIGINS ?? "http://localhost:3001").split(",").map(s => s.trim());
  app.use("*", cors({ origin: corsOrigins, credentials: true }));

  // Rate limit — token bucket per API key. Defaults: 60 requests / 60 seconds.
  // Override with MACHTSINN_RATE_LIMIT_RPS (requests-per-second cap) and MACHTSINN_RATE_LIMIT_BURST.
  const rateLimitRps = Number(process.env.MACHTSINN_RATE_LIMIT_RPS ?? "1");
  const rateLimitBurst = Number(process.env.MACHTSINN_RATE_LIMIT_BURST ?? "60");
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();
  app.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname === "/health") return next();
    const key = c.req.header("x-api-key") ?? "no-key";
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: rateLimitBurst, lastRefill: now };
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(rateLimitBurst, bucket.tokens + elapsed * rateLimitRps);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / rateLimitRps);
      c.header("retry-after", String(retryAfter));
      return c.json({ error: "rate limit exceeded", retry_after_seconds: retryAfter }, 429);
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return next();
  });

  // API key auth → resolve to user identity. Keys map to user_id.
  // SECURITY: x-actor is a *labeling* header for auditing different agents within the same
  // owner (e.g. "cursor", "claude-code", "auto-link") but cannot be used to impersonate
  // another owner. Format is "<owner>:<label>" or just "<label>" (prefix is added automatically).
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname === "/health") return next();
    const key = c.req.header("x-api-key") ?? "";
    const owner = cfg.apiKeys[key];
    if (!owner) return c.json({ error: "invalid api key" }, 401);
    c.set("owner", owner);

    const rawActor = c.req.header("x-actor")?.trim() ?? "";
    let actor: string;
    if (!rawActor) {
      actor = owner;
    } else if (rawActor.includes(":")) {
      // Owner-prefixed form must match the authenticated owner; reject spoofing attempts.
      const [claimedOwner, label] = rawActor.split(":", 2);
      if (claimedOwner !== owner) {
        return c.json({ error: "x-actor owner-prefix does not match authenticated owner" }, 403);
      }
      actor = `${owner}:${label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32)}`;
    } else {
      // Bare label — owner is always prepended; cross-owner forgery is impossible.
      actor = `${owner}:${rawActor.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32)}`;
    }
    c.set("actor", actor);
    return next();
  });

  app.get("/health", c => c.json({ ok: true, service: "machtsinn.ai", version: "1.0.0" }));

  // Safe body parser — returns 400 on malformed JSON instead of leaking a 500 with stack.
  // Use everywhere that calls c.req.json() on user-supplied bodies.
  async function parseJsonBody<T>(c: any): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
    try {
      const body = await c.req.json();
      return { ok: true, body };
    } catch {
      return { ok: false, response: c.json({ error: "invalid JSON body" }, 400) };
    }
  }

  // POST /v1/remember
  app.post("/v1/remember", async c => {
    const parsed = await parseJsonBody<RememberInput>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");
    const input: RememberInput = { ...body, owner };
    if (!input.content || !input.type || !input.scope) {
      return c.json({ error: "content, type, scope required" }, 400);
    }
    let memory;
    try {
      memory = writeMemory(vault, input);
    } catch (e: any) {
      return c.json({ error: e.message ?? String(e) }, 400);
    }
    logOp({
      op: "WRITE",
      memory_id: memory.frontmatter.id,
      owner,
      actor: c.get("actor"),
      source: input.source,
      trust_after: memory.frontmatter.trust,
    });
    return c.json({ memory });
  });

  // POST /v1/recall
  app.post("/v1/recall", async c => {
    const parsed = await parseJsonBody<RecallInput>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");
    const scope = body.scope ?? "current";

    const hits = await ripgrepSearch(cfg.vaultRoot, body.query);
    const filtered = hits.filter(h => canRead(h.memory, owner, scope as any, body.entity));
    const typeFiltered = body.type ? filtered.filter(h => h.memory.frontmatter.type === body.type) : filtered;
    const tagFiltered = body.tags?.length
      ? typeFiltered.filter(h => body.tags!.every(t => h.memory.frontmatter.tags.includes(t)))
      : typeFiltered;

    const scored = scoreHits(tagFiltered, body.query);
    const limit = Math.max(1, Math.min(body.limit ?? 10, 100));
    const result = scored.slice(0, limit);

    logOp({
      op: "RETRIEVE",
      memory_id: result[0]?.memory.frontmatter.id ?? "no-results",
      owner,
      actor: c.get("actor"),
      source: `query: "${body.query}"`,
      reason: `scope=${typeof scope === "string" ? scope : scope.join(",")} entity=${body.entity ?? "-"} results=${result.length}`,
    });

    return c.json({ query: body.query, scope, count: result.length, results: result });
  });

  // POST /v1/forget
  app.post("/v1/forget", async c => {
    const parsed = await parseJsonBody<ForgetInput>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");
    const before = findMemoryById(vault, body.id);
    // Uniform 404 for both not-found and not-owned (no existence oracle).
    if (!before || before.frontmatter.owner !== owner) return c.json({ error: "not found" }, 404);
    const after = forgetMemory(vault, body.id, body.reason);
    logOp({
      op: "FORGET",
      memory_id: body.id,
      owner,
      actor: c.get("actor"),
      reason: body.reason,
      trust_before: before.frontmatter.trust,
      trust_after: after?.frontmatter.trust ?? null,
    });
    return c.json({ memory: after });
  });

  // PUT /v1/memory/:id (UPDATE)
  app.put("/v1/memory/:id", async c => {
    const id = c.req.param("id");
    const parsed = await parseJsonBody<UpdateInput>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");
    const before = findMemoryById(vault, id);
    // Uniform 404 to avoid existence oracle.
    if (!before || before.frontmatter.owner !== owner) return c.json({ error: "not found" }, 404);
    const after = updateMemory(vault, id, body);
    logOp({
      op: "UPDATE",
      memory_id: id,
      owner,
      actor: c.get("actor"),
      diff: JSON.stringify({ before: before.frontmatter, after: after?.frontmatter }),
      trust_before: before.frontmatter.trust,
      trust_after: after?.frontmatter.trust ?? null,
    });
    return c.json({ memory: after });
  });

  // GET /v1/memory/:id
  // 404 for both not-found and not-readable: collapses the existence oracle that
  // would otherwise let a caller distinguish "private memory exists" from "no such id".
  // Timing-safe: isReadable() checks the index (no file read) so a 404 returns at the
  // same speed regardless of whether the underlying file exists.
  app.get("/v1/memory/:id", async c => {
    const id = c.req.param("id");
    const owner = c.get("owner");
    if (!isReadable(vault, id, owner)) return c.json({ error: "not found" }, 404);
    const m = findMemoryById(vault, id);
    if (!m) return c.json({ error: "not found" }, 404);
    return c.json({ memory: m });
  });

  // GET /v1/log
  app.get("/v1/log", c => {
    const owner = c.get("owner");
    const memory_id = c.req.query("memory_id");
    const op = c.req.query("op") as any;
    const since = c.req.query("since");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
    // /v1/log is ALWAYS scoped to the caller's owner. Cross-owner audit access is reserved
    // for admin keys (not implemented here; would require a role flag in apiKeys map).
    const entries = queryLog({ memory_id, op, since, limit, owner });
    return c.json({ count: entries.length, entries });
  });

  // POST /v1/consolidate — scan the vault, propose meaningful patterns observed in 3+ distinct entities.
  // Quality filters:
  //   1. Stopword exclusion (drops "context", "purpose", "what", etc.)
  //   2. Saturation cap (drops tokens appearing in >25% of total docs — they're not patterns, they're vocabulary)
  //   3. Document-frequency-weighted scoring (rare-but-clustered terms beat ubiquitous ones)
  //   4. Minimum length 5, must contain a vowel and ≥1 letter, not pure numeric
  //   5. Prefer tokens that also appear in TAGS (intentional categorization signal)
  app.post("/v1/consolidate", async c => {
    // Consolidate accepts an empty body (uses defaults). Use parseJsonBody for
    // contract uniformity with sibling endpoints; treat malformed JSON as 400.
    let body: { min_entities?: number; min_occurrences?: number; limit?: number; max_saturation?: number } = {};
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      const parsed = await parseJsonBody<typeof body>(c);
      if (!parsed.ok) return parsed.response;
      body = parsed.body;
    }
    const minEntities = body.min_entities ?? 3;
    const minOccurrences = body.min_occurrences ?? 3;
    const maxSaturation = body.max_saturation ?? 0.25;
    const limit = body.limit ?? 30;

    type Candidate = { token: string; sources: Set<string>; entities: Set<string>; tagHits: number; samples: string[] };
    const candidates = new Map<string, Candidate>();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

    // Stopwords — common English + markdown/yaml/template noise
    const STOPWORDS = new Set([
      "about","above","after","again","against","also","although","always","another","any","are","aren","arent","because",
      "been","before","being","below","between","both","but","came","can","cant","cannot","come","could","couldnt","did",
      "didnt","does","doesnt","doing","done","down","during","each","either","else","every","few","for","from","further",
      "had","hadnt","has","hasnt","have","havent","having","here","heres","hers","herself","himself","its","itself","just",
      "let","lets","like","made","make","many","may","me","might","mine","more","most","must","mustnt","myself","need",
      "never","new","next","nor","not","note","notes","now","off","often","once","only","other","others","ought","our",
      "ours","ourselves","out","over","own","part","parts","really","said","same","see","seen","she","should","shouldnt",
      "since","some","still","such","take","than","that","thats","the","their","theirs","them","themselves","then","there",
      "these","they","theyll","theyre","theyve","this","those","through","thus","too","under","until","upon","use","used",
      "uses","using","very","want","was","wasnt","were","werent","what","whats","when","where","whether","which","while",
      "who","whom","whose","why","will","with","within","without","wont","would","wouldnt","you","youll","youre","youve",
      "your","yours","yourself","yourselves",
      // template / structural words common across markdown:
      "context","purpose","type","types","change","changes","single","quick","table","setup","record","records","file",
      "files","source","sources","target","targets","content","contents","summary","example","examples","section","sections",
      "header","headers","field","fields","value","values","item","items","list","lists","name","names","date","dates",
      "time","times","day","days","week","weeks","month","months","year","years","january","february","march","april",
      "may","june","july","august","september","october","november","december","monday","tuesday","wednesday","thursday",
      "friday","saturday","sunday","tag","tags","key","keys","main","step","steps","start","stop","done","end","ends",
      "first","second","third","last","total","new","old","next","previous","current","action","actions","status","level",
      "based","entry","entries","more","less","top","bottom","left","right","input","output","result","results","case",
      "cases","tool","tools","data","info","information","detail","details","point","points","question","questions","answer",
      "answers","reason","reasons","line","lines","page","pages","update","updates","check","checks","try","run","runs",
      // very common tech/business words that aren't patterns:
      "user","users","agent","agents","model","models","system","systems","platform","platforms","service","services",
      "code","test","tests","build","builds","release","releases","version","versions","feature","features","issue","issues",
      "task","tasks","work","works","project","projects","company","companies","team","teams","group","groups","org","orgs",
      "client","clients","customer","customers","product","products","market","markets","plan","plans","cost","costs",
      "price","prices","time","cloud","clouds","memory","memories","prompt","prompts","note","notes","fact","facts",
      "thing","things","stuff","topic","topics","theme","themes","area","areas","kind","kinds","sort","sorts","style","styles",
      "must","cant","wont","didnt","doesnt","hasnt","havent","isnt","arent","wasnt","werent","weve","theyve","wouldnt",
      "couldnt","shouldnt","im","ive","ill","id","whats","heres","theres","wheres","whos","hows",
      "high","low","big","small","large","good","better","best","bad","worse","worst","easy","hard","early","late",
      "important","specific","general","specific","yes","yeah","yep","nope","ok","okay","sure","maybe","actually","really",
      "very","much","little","lot","lots","plenty","enough","some","many","few","several","various","different","similar",
      "true","false","null","none","both","either","each","every","another","other","another",
      "their","there","these","those","this","that",
    ]);

    const owner = c.get("owner");
    let totalDocs = 0;
    for (const m of walkVault(vault)) {
      if (m.frontmatter.forgotten) continue;
      if (m.frontmatter.scope === "generalized") continue;
      // ISOLATION: consolidate may only see memories the caller is allowed to read.
      if (!canRead(m, owner, "all")) continue;
      totalDocs++;

      const tagSet = new Set(m.frontmatter.tags.map(norm));
      const tokens = new Set<string>();

      // HIGH SIGNAL extraction only:
      //   1. Tags — explicitly curated
      //   2. Hyphenated words — technical/compound terms (multi-tenant, diamond-hands, swiss-tax)
      //   3. Multi-word Title-Case phrases — proper nouns (Diamond Hands, Swiss Tax)
      for (const t of tagSet) tokens.add(t);

      // Hyphenated words (compound technical terms)
      const hyphenated = (m.body.match(/\b[a-z][a-z]+(?:-[a-z][a-z]+){1,4}\b/gi) ?? []).slice(0, 200);
      for (const h of hyphenated) {
        const n = norm(h);
        if (n.length >= 7) tokens.add(n);
      }

      // Multi-word Title-Case phrases (Diamond Hands, Swiss Tax, Azure Landing Zone)
      const phrases = (m.body.match(/\b(?:[A-Z][a-z]{2,15}\s+){1,3}[A-Z][a-z]{2,15}\b/g) ?? []).slice(0, 100);
      for (const p of phrases) {
        const n = p.toLowerCase().replace(/\s+/g, "-");
        if (n.length >= 7) tokens.add(n);
      }

      for (const t of tokens) {
        if (!t || t.length < 5) continue;
        if (STOPWORDS.has(t)) continue;
        if (/^[0-9-]+$/.test(t)) continue; // pure numeric
        if (!/[aeiouy]/.test(t)) continue; // must have a vowel (drops acronyms)

        const cand = candidates.get(t) ?? { token: t, sources: new Set(), entities: new Set(), tagHits: 0, samples: [] };
        cand.sources.add(m.frontmatter.id);
        if (m.frontmatter.scope === "entity" && m.frontmatter.entity) cand.entities.add(m.frontmatter.entity);
        if (tagSet.has(t)) cand.tagHits++;
        if (cand.samples.length < 3) {
          const ent = m.frontmatter.entity ?? m.frontmatter.scope;
          cand.samples.push(`${ent}: ${m.frontmatter.aliases?.[0] ?? m.frontmatter.id.slice(-6)}`);
        }
        candidates.set(t, cand);
      }
    }

    // TF-IDF-like quality scoring:
    //   - saturation = sources / totalDocs (drop if > maxSaturation — too common to be a pattern)
    //   - tagBonus = (tagHits / sources) — rewards intentional tagging
    //   - clusterScore = entities * 3 + sources + tagBonus * 5
    //   - rarityBonus = (1 - saturation) * 10
    const proposals = [...candidates.values()]
      .map(c => {
        const saturation = c.sources.size / Math.max(totalDocs, 1);
        const tagRatio = c.tagHits / Math.max(c.sources.size, 1);
        const score = c.entities.size * 3 + c.sources.size + (tagRatio * 5) + ((1 - saturation) * 10);
        return {
          token: c.token,
          occurrences: c.sources.size,
          saturation: Math.round(saturation * 1000) / 1000,
          tag_hits: c.tagHits,
          distinct_entities: [...c.entities],
          source_ids: [...c.sources],
          samples: c.samples,
          score: Math.round(score * 10) / 10,
        };
      })
      .filter(p => p.distinct_entities.length >= minEntities)
      .filter(p => p.occurrences >= minOccurrences)
      .filter(p => p.saturation <= maxSaturation)   // pattern, not vocabulary
      .filter(p => p.token.length >= 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return c.json({
      total_docs: totalDocs,
      min_entities: minEntities,
      min_occurrences: minOccurrences,
      max_saturation: maxSaturation,
      proposal_count: proposals.length,
      proposals,
      note: "Quality-filtered. Call POST /v1/promote with selected source_ids to materialize a hub.",
    });
  });

  // POST /v1/link — add a typed hub-to-hub edge (sibling/parent/children/supersedes/alternatives)
  app.post("/v1/link", async c => {
    const parsed = await parseJsonBody<{ from: string; to: string | string[]; edge: "sibling" | "parent" | "children" | "supersedes" | "alternatives" }>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");
    const from = findMemoryById(vault, body.from);
    // OWNERSHIP + EXISTENCE both collapse to uniform 404 (no existence oracle).
    if (!from || from.frontmatter.owner !== owner) {
      return c.json({ error: "not found" }, 404);
    }

    const targets = Array.isArray(body.to) ? body.to : [body.to];
    for (const t of targets) {
      const target = findMemoryById(vault, t);
      if (!target || !canRead(target, owner, "all")) {
        return c.json({ error: "not found" }, 404);
      }
    }

    let patch: any = {};
    if (body.edge === "sibling") {
      const cur = from.frontmatter.siblings ?? [];
      patch.siblings = [...new Set([...cur, ...targets])];
    } else if (body.edge === "parent") {
      if (targets.length !== 1) return c.json({ error: "parent edge takes a single target" }, 400);
      patch.parent = targets[0];
    } else if (body.edge === "children") {
      const cur = from.frontmatter.children ?? [];
      patch.children = [...new Set([...cur, ...targets])];
    } else if (body.edge === "supersedes") {
      if (targets.length !== 1) return c.json({ error: "supersedes edge takes a single target" }, 400);
      patch.supersedes = targets[0];
    } else if (body.edge === "alternatives") {
      const cur = from.frontmatter.alternatives ?? [];
      patch.alternatives = [...new Set([...cur, ...targets])];
    } else {
      return c.json({ error: `unknown edge type: ${body.edge}` }, 400);
    }

    const updated = updateMemory(vault, body.from, patch);
    logOp({
      op: "UPDATE",
      memory_id: body.from,
      owner,
      actor: c.get("actor"),
      reason: `link edge=${body.edge} to ${targets.join(",")}`,
    });
    return c.json({ memory: updated });
  });

  // POST /v1/promote — create a generalized hub from 3+ source memories
  // Enforces the N=3 promotion rule across distinct entities.
  app.post("/v1/promote", async c => {
    const parsed = await parseJsonBody<{
      source_ids: string[];
      content: string;
      category?: string;
      tags?: string[];
      visibility?: "team" | "public";
    }>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const owner = c.get("owner");

    if (!Array.isArray(body.source_ids) || body.source_ids.length < 3) {
      return c.json({ error: "promote requires at least 3 source_ids (the N=3 rule)" }, 400);
    }

    const sources = body.source_ids
      .map(id => findMemoryById(vault, id))
      .filter((m): m is NonNullable<typeof m> => !!m);

    // Uniform 404 covers both not-found and not-readable to avoid existence oracle.
    // Source IDs are caller-supplied; legitimate use cases see all-or-nothing 404 either way.
    const unauthorized = sources.filter(s => !canRead(s, owner, "all"));
    if (sources.length !== body.source_ids.length || unauthorized.length > 0) {
      return c.json({ error: "one or more source IDs not found" }, 404);
    }

    const distinctEntities = new Set(
      sources
        .filter(s => s.frontmatter.scope === "entity")
        .map(s => s.frontmatter.entity)
    );
    if (distinctEntities.size < 3) {
      return c.json({
        error: "promotion requires patterns from 3+ distinct entities",
        distinct_entities_found: [...distinctEntities],
      }, 400);
    }

    // Write the new generalized hub
    const hub = writeMemory(vault, {
      content: body.content,
      type: "semantic",
      scope: "generalized",
      owner,
      category: body.category,
      tags: body.tags ?? [],
      links: body.source_ids,
      visibility: body.visibility ?? "team",
      source: `promoted from ${body.source_ids.join(",")}`,
    });

    logOp({
      op: "WRITE",
      memory_id: hub.frontmatter.id,
      owner,
      actor: c.get("actor"),
      source: `promote from ${body.source_ids.length} sources`,
      reason: `entities: ${[...distinctEntities].join(",")}`,
    });

    // Backlink each source memory to the new hub — BUT ONLY for sources the promoter
    // owns. Mutating another user's frontmatter without their consent is a cross-owner
    // write primitive (Codex audit finding NEW-D in v0.6). Foreign sources still appear
    // in the hub's links[], but the back-pointer is one-way.
    const backlinked: string[] = [];
    const skipped_foreign: string[] = [];
    for (const src of sources) {
      if (src.frontmatter.owner !== owner) {
        skipped_foreign.push(src.frontmatter.id);
        continue;
      }
      const newLinks = [...new Set([...src.frontmatter.links, hub.frontmatter.id])];
      const updated = updateMemory(vault, src.frontmatter.id, { links: newLinks });
      if (updated) {
        backlinked.push(src.frontmatter.id);
        logOp({
          op: "UPDATE",
          memory_id: src.frontmatter.id,
          owner: src.frontmatter.owner,
          actor: c.get("actor"),
          reason: `backlink from promotion to ${hub.frontmatter.id}`,
        });
      }
    }

    return c.json({
      hub,
      promoted_from: body.source_ids.length,
      distinct_entities: [...distinctEntities],
      skipped_foreign_backlinks: skipped_foreign,
      backlinked,
    });
  });

  // GET /v1/topology/health — topology rule violations + warnings
  // ISOLATION: only memories the caller can read are counted/listed.
  app.get("/v1/topology/health", c => {
    const owner = c.get("owner");
    type HubInfo = { id: string; label: string; spokes: string[]; entities: Set<string> };
    const hubs = new Map<string, HubInfo>();
    const directEntityEdges: { from: string; to: string; via: string }[] = [];

    // Build hub spoke map by walking all generalized memories and their links.
    // FIX: links are stored as `[[ULID]]` wikilinks; byId is keyed on raw ULID.
    // Use fromWikilink() to unwrap before lookup.
    const memories: any[] = [];
    for (const m of walkVault(vault)) {
      if (m.frontmatter.forgotten) continue;
      if (!canRead(m, owner, "all")) continue;
      memories.push(m);
    }
    const byId = new Map(memories.map(m => [m.frontmatter.id, m]));

    for (const m of memories) {
      if (m.frontmatter.scope === "generalized") {
        const info: HubInfo = {
          id: m.frontmatter.id,
          label: m.frontmatter.category ? `${m.frontmatter.category}/${m.frontmatter.id.slice(-6)}` : m.frontmatter.id,
          spokes: m.frontmatter.links,
          entities: new Set(),
        };
        for (const linkRaw of m.frontmatter.links) {
          const linkId = fromWikilink(linkRaw);
          const target = byId.get(linkId);
          if (target && target.frontmatter.scope === "entity" && target.frontmatter.entity) {
            info.entities.add(target.frontmatter.entity);
          }
        }
        hubs.set(m.frontmatter.id, info);
      }
    }

    // Detect direct entity→entity edges (isolation violations) — also unwrap wikilinks.
    for (const m of memories) {
      if (m.frontmatter.scope !== "entity") continue;
      for (const linkRaw of m.frontmatter.links) {
        const linkId = fromWikilink(linkRaw);
        const target = byId.get(linkId);
        if (!target) continue;
        if (target.frontmatter.scope === "entity" && target.frontmatter.entity !== m.frontmatter.entity) {
          directEntityEdges.push({
            from: `${m.frontmatter.entity}/${m.frontmatter.id.slice(-6)}`,
            to: `${target.frontmatter.entity}/${target.frontmatter.id.slice(-6)}`,
            via: m.frontmatter.id,
          });
        }
      }
    }

    const hubList = [...hubs.values()];
    const bulging = hubList.filter(h => h.spokes.length >= 30);
    const orphan = hubList.filter(h => h.spokes.length <= 2);
    const healthy = hubList.filter(h => h.spokes.length >= 3 && h.spokes.length <= 15);
    const dense = hubList.filter(h => h.spokes.length > 15 && h.spokes.length < 30);

    // Maturity stage derived from hub count + structural signals.
    // Birth: no hubs. Crystallization: 1-5 hubs. Dense maturity: 6-30 hubs.
    // Self-organization: 30+ hubs OR categories present forming sub-constellations.
    const categories = new Set<string>();
    for (const m of memories) {
      if (m.frontmatter.scope === "generalized" && m.frontmatter.category) categories.add(m.frontmatter.category);
    }
    // Stage progression: hub count is primary signal; categories ≥ 2 promote to Self-organization
    // ONLY when hub count is already mature (≥ 6).
    let stage: string;
    if (hubList.length === 0) stage = "Birth";
    else if (hubList.length <= 5) stage = "Crystallization";
    else if (hubList.length <= 30 && categories.size < 2) stage = "Dense maturity";
    else if (hubList.length > 30 || categories.size >= 2) stage = "Self-organization";
    else stage = "Dense maturity";

    // Hub-to-hub edge tally
    const edgeCounts = { sibling: 0, parent: 0, children: 0, supersedes: 0, alternatives: 0 };
    for (const m of memories) {
      if (m.frontmatter.scope !== "generalized") continue;
      edgeCounts.sibling += (m.frontmatter.siblings ?? []).length;
      edgeCounts.parent += m.frontmatter.parent ? 1 : 0;
      edgeCounts.children += (m.frontmatter.children ?? []).length;
      edgeCounts.supersedes += m.frontmatter.supersedes ? 1 : 0;
      edgeCounts.alternatives += (m.frontmatter.alternatives ?? []).length;
    }

    return c.json({
      maturity_stage: stage,
      hub_count: hubList.length,
      healthy_hubs: healthy.length,
      dense_hubs: dense.length,
      categories: [...categories].sort(),
      hub_to_hub_edges: edgeCounts,
      bulging_hubs: bulging.map(h => ({ id: h.id, label: h.label, spokes: h.spokes.length })),
      orphan_hubs: orphan.map(h => ({ id: h.id, label: h.label, spokes: h.spokes.length })),
      direct_entity_edges: directEntityEdges,
      violations:
        bulging.length + orphan.length + directEntityEdges.length === 0
          ? "none"
          : `${bulging.length} bulging, ${orphan.length} orphan, ${directEntityEdges.length} leaks`,
      recommendations: [
        ...bulging.map(h => `SPLIT hub ${h.label} — ${h.spokes.length} spokes exceeds 30`),
        ...orphan.map(h => `DEMOTE hub ${h.label} — only ${h.spokes.length} spokes`),
        ...directEntityEdges.map(e => `AUDIT direct edge ${e.from} → ${e.to} (no generalized intermediary)`),
      ],
    });
  });

  // GET /v1/list — paginated list of memories (frontmatter only, no body unless requested).
  // Useful for bulk operations (auto-linking, consolidation, etc.) where recall is overkill.
  app.get("/v1/list", c => {
    const owner = c.get("owner");
    const scope = c.req.query("scope") as any;
    const entity = c.req.query("entity") ?? undefined;
    const withBody = c.req.query("body") === "1";
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 10000);

    const out: any[] = [];
    for (const m of walkVault(vault)) {
      if (m.frontmatter.forgotten) continue;
      if (!canRead(m, owner, scope ?? "all", entity)) continue;
      if (out.length >= limit) break;
      out.push({
        frontmatter: m.frontmatter,
        ...(withBody ? { body: m.body } : {}),
        path: m.path,
      });
    }
    return c.json({ count: out.length, memories: out });
  });

  // GET /v1/stats — topology snapshot
  // A "hub" is ONLY a memory in the generalized/ scope. Within-entity wikilinks are regular edges,
  // not hubs — they form clusters but don't count toward hub-and-spoke topology metrics.
  // ISOLATION: only memories the caller can read are counted.
  app.get("/v1/stats", c => {
    const owner = c.get("owner");
    const memories: Record<string, number> = {};
    const entitySet = new Set<string>();
    const userSet = new Set<string>();
    const categorySet = new Set<string>();
    let total = 0;
    let totalEdges = 0;
    const hubSpokes: Record<string, number> = {};

    for (const m of walkVault(vault)) {
      if (m.frontmatter.forgotten) continue;
      if (!canRead(m, owner, "all")) continue;
      total++;
      totalEdges += m.frontmatter.links.length;
      if (m.frontmatter.scope === "entity" && m.frontmatter.entity) entitySet.add(m.frontmatter.entity);
      if (m.frontmatter.scope === "user") userSet.add(m.frontmatter.owner);
      if (m.frontmatter.scope === "generalized" && m.frontmatter.category) categorySet.add(m.frontmatter.category);
      const key = m.frontmatter.scope === "entity"
        ? `entity:${m.frontmatter.entity}`
        : m.frontmatter.scope === "generalized"
          ? `generalized:${m.frontmatter.category ?? "_"}`
          : `user:${m.frontmatter.owner}`;
      memories[key] = (memories[key] ?? 0) + 1;
      if (m.frontmatter.scope === "generalized") {
        hubSpokes[m.frontmatter.id] = m.frontmatter.links.length;
      }
    }
    const spokeCounts = Object.values(hubSpokes);
    const maxSpokes = spokeCounts.length ? Math.max(...spokeCounts) : 0;
    const avgSpokes = spokeCounts.length ? spokeCounts.reduce((a, b) => a + b, 0) / spokeCounts.length : 0;
    return c.json({
      total_memories: total,
      total_edges: totalEdges,
      entities: [...entitySet].sort(),
      users: [...userSet].sort(),
      generalized_categories: [...categorySet].sort(),
      memories_by_scope: memories,
      hubs: Object.keys(hubSpokes).length,
      max_spokes: maxSpokes,
      avg_spokes: Math.round(avgSpokes * 10) / 10,
      warning: maxSpokes >= 30 ? `super-hub bulging (${maxSpokes} spokes) — consider split` : null,
    });
  });

  return app;
}
