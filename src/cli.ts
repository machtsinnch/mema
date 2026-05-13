#!/usr/bin/env bun
// machtsinn — command-line client. Talks to the HTTP server.
// Config: ~/.machtsinn/config.json — { url, key, scope: { entity }, actor }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CFG_DIR = join(homedir(), ".machtsinn");
const CFG_PATH = join(CFG_DIR, "config.json");

interface Config {
  url: string;
  key: string;
  actor?: string;
  scope?: { entity?: string };
}

function loadCfg(): Config {
  let cfg: Config = {
    url: process.env.MACHTSINN_URL ?? "http://localhost:3001",
    key: process.env.MACHTSINN_KEY ?? "",
  };
  if (existsSync(CFG_PATH)) {
    const fileCfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    cfg = { ...fileCfg, ...cfg, url: cfg.url, key: cfg.key || fileCfg.key };
    cfg.scope = fileCfg.scope;
    cfg.actor = fileCfg.actor;
  }
  if (!cfg.key) {
    console.error("error: no API key. Set MACHTSINN_KEY env var or run `machtsinn login <key>`.");
    process.exit(1);
  }
  return cfg;
}

function saveCfg(cfg: Config): void {
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

async function api(cfg: Config, method: "GET" | "POST" | "PUT", path: string, body?: any): Promise<any> {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      "x-api-key": cfg.key,
      ...(cfg.actor ? { "x-actor": cfg.actor } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const help = `machtsinn — AI memory CLI

usage:
  machtsinn login <key>                       store API key
  machtsinn scope [<entity>]                  show or set working entity
  machtsinn add <content>                     write a memory
    --type semantic|episodic|procedural|working   (default: semantic)
    --scope entity|generalized|user               (default: from config or 'user')
    --entity <name>                               (overrides config)
    --category <name>                             (for generalized)
    --tags tag1,tag2
    --visibility private|project|team|public
    --path project-1/research                     (custom hierarchical path)

  machtsinn find <query>                      search memories
    --scope current|all  (default: current)
    --entity <name>      (entity context)
    --type <type>        (filter by type)
    --tags tag1,tag2     (require all tags)
    --limit <n>          (default: 10)

  machtsinn show <id>                         print memory contents
  machtsinn forget <id> --reason "why"        soft-delete
  machtsinn log [--limit <n>]                 recent operations
  machtsinn stats                             topology stats
  machtsinn health                            topology rule violations
  machtsinn promote --sources id1,id2,id3 --content "pattern..." [--category architecture]
`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(help);
    return;
  }

  // `login` runs before config-load so first-time setup works.
  if (cmd === "login") {
    const key = rest[0];
    if (!key) { console.error("usage: machtsinn login <key>"); process.exit(1); }
    const existing = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, "utf8")) : {};
    saveCfg({ ...existing, url: existing.url ?? "http://localhost:3001", key });
    console.log(`✓ saved key to ${CFG_PATH}`);
    return;
  }

  const cfg = loadCfg();
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "scope": {
      if (positional[0]) {
        const next = { ...cfg, scope: { entity: positional[0] } };
        saveCfg(next);
        console.log(`✓ working entity set to: ${positional[0]}`);
      } else {
        console.log(cfg.scope?.entity ? `current entity: ${cfg.scope.entity}` : "no entity set");
      }
      return;
    }

    case "add": {
      const content = positional.join(" ").trim();
      if (!content) { console.error("error: content required"); process.exit(1); }
      const tags = flags.tags ? String(flags.tags).split(",").map(t => t.trim()).filter(Boolean) : [];
      const scope = (flags.scope as string) ?? (cfg.scope?.entity ? "entity" : "user");
      const entity = (flags.entity as string) ?? cfg.scope?.entity;
      const body: any = {
        content,
        type: (flags.type as string) ?? "semantic",
        scope,
        tags,
      };
      if (scope === "entity") body.entity = entity;
      if (scope === "generalized") body.category = (flags.category as string) ?? "general";
      if (flags.visibility) body.visibility = flags.visibility;
      if (flags.path) body.path = flags.path;
      const res = await api(cfg, "POST", "/v1/remember", body);
      console.log(`✓ ${res.memory.frontmatter.id}`);
      console.log(`  ${res.memory.path}`);
      return;
    }

    case "find": {
      const query = positional.join(" ");
      if (!query) { console.error("error: query required"); process.exit(1); }
      const body: any = {
        query,
        scope: (flags.scope as string) ?? "current",
        entity: (flags.entity as string) ?? cfg.scope?.entity,
        type: flags.type,
        tags: flags.tags ? String(flags.tags).split(",") : undefined,
        limit: flags.limit ? Number(flags.limit) : 10,
      };
      const res = await api(cfg, "POST", "/v1/recall", body);
      console.log(`${res.count} result(s) for "${query}":\n`);
      for (const hit of res.results) {
        const fm = hit.memory.frontmatter;
        const scopeLabel = fm.scope === "entity" ? fm.entity : fm.scope === "generalized" ? `gen/${fm.category}` : `user/${fm.owner}`;
        console.log(`  [${hit.score.toFixed(3)}] ${fm.id}  ${scopeLabel}  ${fm.type}`);
        if (hit.snippets[0]) console.log(`         ${hit.snippets[0].slice(0, 100)}`);
      }
      return;
    }

    case "show": {
      const id = positional[0];
      if (!id) { console.error("error: id required"); process.exit(1); }
      const res = await api(cfg, "GET", `/v1/memory/${id}`);
      const m = res.memory;
      console.log(`id:      ${m.frontmatter.id}`);
      console.log(`scope:   ${m.frontmatter.scope}${m.frontmatter.entity ? ` (${m.frontmatter.entity})` : ""}`);
      console.log(`type:    ${m.frontmatter.type}`);
      console.log(`owner:   ${m.frontmatter.owner}`);
      console.log(`trust:   ${m.frontmatter.trust}`);
      console.log(`tags:    ${m.frontmatter.tags.join(", ") || "-"}`);
      console.log(`links:   ${m.frontmatter.links.length} → ${m.frontmatter.links.join(", ") || "-"}`);
      console.log(`path:    ${m.path}`);
      console.log("---");
      console.log(m.body);
      return;
    }

    case "forget": {
      const id = positional[0];
      if (!id) { console.error("error: id required"); process.exit(1); }
      const res = await api(cfg, "POST", "/v1/forget", {
        id,
        actor: cfg.actor ?? "cli",
        reason: (flags.reason as string) ?? "forgotten via CLI",
      });
      console.log(`✓ forgotten: ${id}`);
      return;
    }

    case "log": {
      const limit = flags.limit ? Number(flags.limit) : 20;
      const res = await api(cfg, "GET", `/v1/log?limit=${limit}`);
      console.log(`${res.count} entries:\n`);
      for (const e of res.entries) {
        const reason = e.reason ? ` — ${e.reason}` : "";
        console.log(`  ${e.ts}  ${e.op.padEnd(11)} ${e.memory_id}  by ${e.actor}${reason}`);
      }
      return;
    }

    case "stats": {
      const res = await api(cfg, "GET", "/v1/stats");
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    case "health": {
      const res = await api(cfg, "GET", "/v1/topology/health");
      console.log(`Hubs: ${res.hub_count}  (${res.healthy_hubs} healthy, ${res.dense_hubs} dense)`);
      console.log(`Violations: ${res.violations}`);
      if (res.recommendations.length) {
        console.log("\nRecommendations:");
        for (const r of res.recommendations) console.log(`  • ${r}`);
      }
      return;
    }

    case "promote": {
      const sources = flags.sources ? String(flags.sources).split(",").map(s => s.trim()) : [];
      const content = (flags.content as string) ?? positional.join(" ");
      if (sources.length < 3) { console.error("error: --sources requires 3+ comma-separated IDs"); process.exit(1); }
      if (!content) { console.error("error: --content required"); process.exit(1); }
      const body: any = {
        source_ids: sources,
        content,
        category: flags.category,
        tags: flags.tags ? String(flags.tags).split(",") : [],
        visibility: flags.visibility ?? "team",
      };
      const res = await api(cfg, "POST", "/v1/promote", body);
      console.log(`✓ promoted to hub ${res.hub.frontmatter.id}`);
      console.log(`  from ${res.promoted_from} sources across entities: ${res.distinct_entities.join(", ")}`);
      console.log(`  ${res.hub.path}`);
      return;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.log(help);
      process.exit(1);
  }
}

main().catch(err => {
  console.error("error:", err.message);
  process.exit(1);
});
