#!/usr/bin/env bun
// machtsinn MCP server — exposes memory operations as MCP tools.
// Stdio transport so Claude Code / Cursor / any MCP client can connect.
//
// Configure in ~/.claude.json or ~/.cursor/mcp.json:
//   {
//     "mcpServers": {
//       "machtsinn": {
//         "command": "bun",
//         "args": ["/Users/.../machtsinn.ai/src/mcp.ts"],
//         "env": { "MACHTSINN_URL": "http://localhost:3001", "MACHTSINN_KEY": "dev-ardin" }
//       }
//     }
//   }

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const URL = process.env.MACHTSINN_URL ?? "http://localhost:3001";
const KEY = process.env.MACHTSINN_KEY ?? "";
const ACTOR = process.env.MACHTSINN_ACTOR ?? "mcp";

if (!KEY) {
  console.error("MACHTSINN_KEY not set — MCP server will not function correctly.");
}

async function api(method: "GET" | "POST" | "PUT", path: string, body?: any): Promise<any> {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: {
      "x-api-key": KEY,
      "x-actor": ACTOR,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const tools = [
  {
    name: "memory_remember",
    description: "Write a memory to the machtsinn vault. Memories are markdown files with YAML frontmatter, scoped to an entity (client), the generalized layer, or the user's personal notes.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (markdown body)" },
        type: { type: "string", enum: ["semantic", "episodic", "procedural", "working"], description: "Memory type" },
        scope: { type: "string", enum: ["entity", "generalized", "user"], description: "Where this memory belongs" },
        entity: { type: "string", description: "Required when scope=entity. e.g. 'company-a'" },
        category: { type: "string", description: "Required when scope=generalized. e.g. 'architecture'" },
        path: { type: "string", description: "Optional hierarchical path within scope, e.g. 'project-1/research'" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for retrieval" },
        visibility: { type: "string", enum: ["private", "project", "team", "public"], description: "Access scope" },
        trust: { type: "number", description: "Trust score 0-1, default 0.7" },
      },
      required: ["content", "type", "scope"],
    },
  },
  {
    name: "memory_recall",
    description: "Search the machtsinn vault using hybrid scoring (relevance + recency + importance + trust). Default scope is current entity; pass scope='all' to search across all entities.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (keywords)" },
        scope: { type: "string", description: "'current' | 'all' (default current)" },
        entity: { type: "string", description: "Entity to scope to (used when scope=current)" },
        type: { type: "string", description: "Filter by memory type" },
        tags: { type: "array", items: { type: "string" }, description: "Require all tags" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_show",
    description: "Read a specific memory by ULID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Memory ULID" } },
      required: ["id"],
    },
  },
  {
    name: "memory_forget",
    description: "Soft-delete a memory. The file is not removed; forgotten=true in frontmatter, excluded from future search. Auditable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ULID to forget" },
        reason: { type: "string", description: "Why this is being forgotten (recorded in log)" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "memory_promote",
    description: "Promote a pattern observed across 3+ entities to the generalized layer. Enforces the N=3 rule — requires 3+ source memories from 3+ distinct entities. Creates a generalized hub and back-links the sources.",
    inputSchema: {
      type: "object",
      properties: {
        source_ids: { type: "array", items: { type: "string" }, description: "ULIDs of 3+ source memories (each from a distinct entity)" },
        content: { type: "string", description: "The generalized pattern description" },
        category: { type: "string", description: "Category like 'architecture' or 'methodology'" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for retrieval" },
      },
      required: ["source_ids", "content"],
    },
  },
  {
    name: "memory_stats",
    description: "Return topology stats — total memories, entity list, hub count, spoke distribution. Reveals super-hubs (30+ spokes) needing split.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_health",
    description: "Topology rule violations: bulging hubs (30+ spokes), orphan hubs (<3 spokes), direct entity→entity link leaks. Returns actionable recommendations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_log",
    description: "Recent provenance log entries — every write, update, forget, promote with actor and timestamp.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 20" } },
    },
  },
  // ── v2 tools: six-layer architecture + verifiable assets ─────────────
  {
    name: "memory_v2_observe",
    description: "v2 L1: ingest a raw episode (conversation turn, document, tool call, observation) into the episodic layer.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["conversation", "document", "tool_call", "observation"] },
        content: { type: "string" },
        source: { type: "string", description: "Optional origin reference" },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "memory_v2_fact",
    description: "v2 L2: record a semantic fact (subject-predicate-object) with bi-temporal validity. Use derived_from to cite source episode IDs.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        predicate: { type: "string" },
        object: { type: "string" },
        valid_from: { type: "string", description: "ISO timestamp; defaults to now" },
        valid_to: { type: "string", description: "ISO timestamp; null means still-valid" },
        derived_from: { type: "array", items: { type: "string" } },
        confidence: { type: "number", description: "0.0-1.0" },
      },
      required: ["subject", "predicate", "object", "derived_from"],
    },
  },
  {
    name: "memory_v2_recall",
    description: "v2 L5: hybrid retrieval (keyword + IDF + vector + graph + temporal + policy). Returns verifiable packets with UAL + content hash + governance decision + why_retrieved.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        purpose: { type: "string", description: "Why this recall (used for policy + audit, e.g. 'customer-support')" },
        kinds: { type: "array", items: { type: "string", enum: ["episode", "fact", "cognitive"] } },
        limit: { type: "number" },
        use_vector: { type: "boolean" },
      },
      required: ["query", "purpose"],
    },
  },
  {
    name: "memory_v2_reflect",
    description: "v2 L3: run rule-based reflection over recent episodes/facts, producing cognitive records (experiences, observations, beliefs).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp; defaults to last 7 days" },
        min_support: { type: "number", description: "Minimum convergent evidence count, default 3" },
      },
    },
  },
  {
    name: "memory_v2_audit_log",
    description: "v2 L6: query the hash-chained audit log for the caller's tenant.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["OBSERVE", "EXTRACT", "INVALIDATE", "REFLECT", "RECALL", "POLICY_DENY", "ERASE"] },
        since: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "memory_v2_audit_verify",
    description: "v2 L6: verify the audit hash chain integrity. Returns valid:false with broken_at_seq + reason if tampering is detected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_v2_erase",
    description: "v2 L4: HARD-erase a record by path — overwrites content with a tombstone, audit entry preserved. Required for GDPR/nFADP DSAR.",
    inputSchema: {
      type: "object",
      properties: {
        record_path: { type: "string" },
        reason: { type: "string" },
      },
      required: ["record_path", "reason"],
    },
  },
  {
    name: "memory_v2_asset_wrap",
    description: "v2 L7: wrap a record as a verifiable Memory Asset (computes content_hash + metadata_hash, mints UAL, sets verification_status=unverified).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        kind: { type: "string" },
        scope: { type: "string" },
        id: { type: "string" },
      },
      required: ["path", "kind", "scope", "id"],
    },
  },
  {
    name: "memory_v2_asset_anchor",
    description: "v2 L7: anchor an asset to a target sink (local | customer-audit-bundle | origintrail | custom).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        target: { type: "string" },
      },
      required: ["path", "target"],
    },
  },
] as const;

const server = new Server(
  { name: "machtsinn", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result: any;
    switch (name) {
      case "memory_remember":
        result = await api("POST", "/v1/remember", args);
        break;
      case "memory_recall":
        result = await api("POST", "/v1/recall", args);
        break;
      case "memory_show":
        result = await api("GET", `/v1/memory/${args.id}`);
        break;
      case "memory_forget":
        result = await api("POST", "/v1/forget", { id: args.id, reason: args.reason, actor: ACTOR });
        break;
      case "memory_promote":
        result = await api("POST", "/v1/promote", args);
        break;
      case "memory_stats":
        result = await api("GET", "/v1/stats");
        break;
      case "memory_health":
        result = await api("GET", "/v1/topology/health");
        break;
      case "memory_log":
        result = await api("GET", `/v1/log?limit=${(args as any).limit ?? 20}`);
        break;
      // ── v2 dispatch ─────────────────────────────────────────────────
      case "memory_v2_observe":
        result = await api("POST", "/v2/observe", args);
        break;
      case "memory_v2_fact":
        result = await api("POST", "/v2/fact", args);
        break;
      case "memory_v2_recall":
        result = await api("POST", "/v2/recall", args);
        break;
      case "memory_v2_reflect":
        result = await api("POST", "/v2/reflect", args);
        break;
      case "memory_v2_audit_log": {
        const a = args as any;
        const qs = new URLSearchParams();
        if (a.op) qs.set("op", a.op);
        if (a.since) qs.set("since", a.since);
        if (a.limit) qs.set("limit", String(a.limit));
        result = await api("GET", `/v2/audit/log${qs.toString() ? "?" + qs : ""}`);
        break;
      }
      case "memory_v2_audit_verify":
        result = await api("GET", "/v2/audit/verify");
        break;
      case "memory_v2_erase":
        result = await api("POST", "/v2/erase", args);
        break;
      case "memory_v2_asset_wrap":
        result = await api("POST", "/v2/asset/wrap", args);
        break;
      case "memory_v2_asset_anchor":
        result = await api("POST", "/v2/asset/anchor", args);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Stderr (visible to MCP host) — never stdout (which is the MCP protocol channel).
console.error(`machtsinn MCP server connected (url=${URL}, actor=${ACTOR})`);
