// machtsinn.ai — core type definitions

export type Visibility = "private" | "project" | "team" | "public";
export type MemoryType = "episodic" | "semantic" | "procedural" | "working";
export type Scope = "entity" | "generalized" | "user";

export type Operation =
  | "WRITE"
  | "UPDATE"
  | "FORGET"
  | "CONSOLIDATE"
  | "CONDENSE"
  | "RETRIEVE";

export type HubEdgeType = "sibling" | "parent" | "children" | "supersedes" | "alternatives";

export interface MemoryFrontmatter {
  id: string;
  type: MemoryType;
  scope: Scope;
  owner: string;
  visibility: Visibility;
  entity?: string;
  category?: string;
  path?: string;
  aliases?: string[];        // human-readable name(s) for Obsidian wikilink resolution
  created: string;
  updated: string;
  source?: string;
  trust: number;
  tags: string[];
  // Obsidian-compatible wikilinks: strings of form "[[id]]" or "[[Alias]]"
  links: string[];
  // Typed hub-to-hub edges (apply mainly to generalized hubs):
  siblings?: string[];       // bidirectional peer concepts
  parent?: string;           // generalization-of relationship
  children?: string[];       // specialization-of relationship
  supersedes?: string;       // this hub replaces the referenced one
  alternatives?: string[];   // competing approaches with trade-offs
  forgotten: boolean;
  forgotten_at?: string | null;
  forgotten_reason?: string | null;
}

export interface Memory {
  frontmatter: MemoryFrontmatter;
  body: string;
  path: string;
}

export interface SearchHit {
  memory: Memory;
  score: number;
  components: {
    relevance: number;
    recency: number;
    importance: number;
    trust: number;
  };
  snippets: string[];
}

export interface RememberInput {
  content: string;
  type: MemoryType;
  owner: string;
  scope: Scope;
  visibility?: Visibility;
  entity?: string;
  category?: string;
  path?: string;
  aliases?: string[];   // human-readable name for Obsidian wikilink rendering
  source?: string;
  trust?: number;
  tags?: string[];
  links?: string[];
}

export interface RecallInput {
  query: string;
  owner: string;
  scope?: "current" | "all" | string[];
  entity?: string;
  type?: MemoryType;
  tags?: string[];
  limit?: number;
}

export interface ForgetInput {
  id: string;
  actor: string;
  reason: string;
}

export interface UpdateInput {
  id: string;
  actor: string;
  body?: string;
  trust?: number;
  tags?: string[];
  links?: string[];
  visibility?: Visibility;
}
