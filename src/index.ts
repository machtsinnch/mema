// machtsinn.ai — server entry point.
// Usage: bun src/index.ts
// Env: VAULT_ROOT (default ./data), PORT (default 3001), MACHTSINN_KEYS (csv key:user)

import { join, resolve } from "node:path";
import { initLog } from "./db";
import { buildApi } from "./api";

const VAULT_ROOT = resolve(process.env.VAULT_ROOT ?? join(import.meta.dir, "..", "data"));
const PORT = Number(process.env.PORT ?? 3001);

// API keys → user_id. Format: "key1:ardin,key2:marcel,key3:founder3"
// Default keys for local dev — overridden in production by MACHTSINN_KEYS env.
const DEFAULT_KEYS = "dev-ardin:ardin,dev-marcel:marcel,dev-founder3:founder3";
const keysCsv = process.env.MACHTSINN_KEYS ?? DEFAULT_KEYS;
const apiKeys: Record<string, string> = {};
for (const pair of keysCsv.split(",")) {
  const [k, u] = pair.split(":");
  if (k && u) apiKeys[k.trim()] = u.trim();
}

initLog(join(VAULT_ROOT, "_meta", "log.sqlite"));

const app = buildApi({ vaultRoot: VAULT_ROOT, apiKeys });

console.log(`machtsinn.ai listening on http://localhost:${PORT}`);
console.log(`vault: ${VAULT_ROOT}`);
console.log(`api keys: ${Object.keys(apiKeys).length} configured for users: ${[...new Set(Object.values(apiKeys))].join(", ")}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
