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
