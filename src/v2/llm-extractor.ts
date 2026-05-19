// LLM-augmented fact + entity extraction. Pluggable across providers:
//
//   OllamaExtractor   — local, default. No data leaves the machine. Free.
//                       Models: llama3.1:8b, qwen2.5:7b, mistral-nemo, etc.
//                       Speaks the Ollama HTTP API at localhost:11434.
//
//   AnthropicExtractor — fallback when ANTHROPIC_API_KEY is set. Claude
//                       3.5 Haiku for cost; Sonnet for quality.
//
//   OpenAIExtractor   — fallback when OPENAI_API_KEY is set. gpt-4o-mini.
//
// All three return the SAME JSON shape:
//   { facts: [{subject, predicate, object, confidence}],
//     entities: [{name, type}] }
//
// Used by scripts/extract-facts-llm.ts to replace the heuristic v2.5
// extractor. The heuristic produced ~30% noise; LLM extraction with a
// conservative prompt should be ≤5%.

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}
export interface ExtractedEntity {
  name: string;
  type: string;     // person | organization | concept | place | system
}
export interface ExtractionResult {
  facts: ExtractedFact[];
  entities: ExtractedEntity[];
}

export interface LLMExtractor {
  name: string;
  extract(text: string): Promise<ExtractionResult>;
}

// Strict prompt with explicit anti-noise rules + few-shot examples.
const SYSTEM_PROMPT = `You are a strict structured-fact extractor. You read a markdown document and extract:

1. FACTS — explicit subject-predicate-object claims that the text directly states.
2. ENTITIES — named referents (people, organizations, products, technical systems, places, important concepts).

Rules:
- Only extract claims that are explicit and verifiable from the text. Reject:
  · vague or hypothetical statements ("if we did X", "could be Y")
  · metaphors and rhetorical flourishes
  · author opinions presented as facts
  · sentence fragments
- Predicates must be specific verbs/relations: "founded", "owns", "uses", "rejected", "supersedes", "deploys_to", "depends_on", "is_a", "located_in", "reports_to", "manages", "supports", "integrates_with", "built_on". NEVER use "is", "has", "at" — too generic.
- Subjects and objects must be ENTITIES (proper nouns, products, organizations), not pronouns, articles, or generic words.
- Reject facts where subject or object is a currency amount ("CHF 22"), a number alone, a date alone, or a fragment ("Co-Marketing").
- For entities, type must be one of: person | organization | product | system | place | concept | event.
- Confidence: 0.95 for explicitly stated, 0.85 for clearly implied, ≤0.75 means don't emit.

Output ONLY valid JSON. No prose, no markdown fences. Schema:
{
  "facts": [
    {"subject": "...", "predicate": "...", "object": "...", "confidence": 0.95}
  ],
  "entities": [
    {"name": "...", "type": "..."}
  ]
}

If the document contains zero extractable facts, return {"facts": [], "entities": []}.`;

// Few-shot demo content. Chosen to be in a domain (open-source tech history)
// that is extremely unlikely to appear verbatim in user content. Weaker
// open-weight models (llama3.1:8b, qwen2.5:7b) sometimes regurgitate this
// demo when they can't extract anything substantive from the real input —
// the defense below catches that.
const FEW_SHOT_USER = `Text:
PostgreSQL supports JSONB indexing. The Apache Software Foundation manages the Kafka project. Linus Torvalds founded the Linux kernel project.`;

const FEW_SHOT_ASSISTANT = `{
  "facts": [
    {"subject": "PostgreSQL", "predicate": "supports", "object": "JSONB indexing", "confidence": 0.95},
    {"subject": "Apache Software Foundation", "predicate": "manages", "object": "Kafka project", "confidence": 0.95},
    {"subject": "Linus Torvalds", "predicate": "founded", "object": "Linux kernel project", "confidence": 0.95}
  ],
  "entities": [
    {"name": "PostgreSQL", "type": "system"},
    {"name": "JSONB indexing", "type": "concept"},
    {"name": "Apache Software Foundation", "type": "organization"},
    {"name": "Kafka project", "type": "product"},
    {"name": "Linus Torvalds", "type": "person"},
    {"name": "Linux kernel project", "type": "product"}
  ]
}`;

// Defense-in-depth: if a weak model echoes the few-shot demo verbatim,
// drop those exact triples and entities post-hoc. Real user content with
// these exact triples is extremely unlikely; if it happens, update the
// demo (it's cheap).
const FEW_SHOT_TRIPLES = new Set([
  "postgresql|supports|jsonb indexing",
  "apache software foundation|manages|kafka project",
  "linus torvalds|founded|linux kernel project",
]);
// Partial-regurgitation defense: weaker models sometimes keep the few-shot's
// (predicate, object) pair but swap in a subject from the real input
// (e.g. "PAI supports JSONB indexing" — JSONB was nowhere in the source).
// Drop any fact where (predicate, object) matches the demo regardless of
// subject. Loses recall on the unlikely case that real user content
// genuinely contains those exact (predicate, object) pairs; acceptable
// because the few-shot uses tech-history examples that are easy to swap
// if collision occurs.
const FEW_SHOT_PRED_OBJ = new Set([
  "supports|jsonb indexing",
  "manages|kafka project",
  "founded|linux kernel project",
]);
const FEW_SHOT_ENTITY_NAMES = new Set([
  "postgresql", "jsonb indexing", "apache software foundation",
  "kafka project", "linus torvalds", "linux kernel project",
]);

// v2.14.3+ entity-type whitelist (codex review). The extractor prompt says
// types must be one of seven, but qwen2.5:7b regularly returns invented
// types like "command", "path", "issue", "fix", "stock", "index", "pattern",
// "platform", "feature", "document", "runtime". Drop those at the boundary
// so downstream (createEntity, retrieval scoring, graph view) never sees
// invalid types. Common mistypes can be remapped to the right canonical
// type if obvious; everything else is dropped.
const ALLOWED_ENTITY_TYPES = new Set([
  "person", "organization", "product", "system", "place", "concept", "event",
]);
const TYPE_REMAP: Record<string, string> = {
  // OS/platform names — qwen2.5:7b labels these as "place" too. Anything
  // that's clearly a software runtime/OS becomes "system".
  command: "concept",
  path: "concept",
  pattern: "concept",
  runtime: "system",
  platform: "system",
  feature: "concept",
  document: "concept",
  stock: "product",
  index: "product",
  fund: "product",
  // bug-tracker artifacts the model invented from PLATFORM/SECURITY docs
  issue: "concept",
  fix: "concept",
  bug: "concept",
};

function filterFewShotLeak(r: ExtractionResult): ExtractionResult {
  return {
    facts: r.facts.filter(f => {
      const s = (f.subject ?? "").toLowerCase();
      const p = (f.predicate ?? "").toLowerCase();
      const o = (f.object ?? "").toLowerCase();
      if (FEW_SHOT_TRIPLES.has(`${s}|${p}|${o}`)) return false;
      if (FEW_SHOT_PRED_OBJ.has(`${p}|${o}`)) return false;
      // v2.14.3+: drop role-inverted facts — "Linux fully_supported by PAI"
      // patterns are nearly always model errors (real meaning: PAI supports
      // Linux, with the subject and object swapped). The retrieval scorer
      // can't surface these usefully and they pollute the graph.
      if (o.startsWith("by ")) return false;
      return true;
    }),
    entities: (r.entities
      .filter(e => !FEW_SHOT_ENTITY_NAMES.has((e.name ?? "").toLowerCase()))
      .map(e => {
        const t = (e.type ?? "").toLowerCase().trim();
        if (ALLOWED_ENTITY_TYPES.has(t)) return { ...e, type: t };
        const remapped = TYPE_REMAP[t];
        if (remapped) return { ...e, type: remapped };
        return null;
      })
      .filter((e): e is ExtractedEntity => e !== null)
    ),
  };
}

function parseStrictJson(raw: string): ExtractionResult {
  // Strip code fences if model emitted them despite instructions.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Some models prepend "Here is the JSON:" — strip leading non-{ chars.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  return filterFewShotLeak({
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    entities: Array.isArray(obj.entities) ? obj.entities : [],
  });
}

// ── OllamaExtractor ──────────────────────────────────────────────────

export class OllamaExtractor implements LLMExtractor {
  readonly name: string;
  private url: string;
  private model: string;
  constructor(opts: { url?: string; model?: string } = {}) {
    this.url = opts.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "llama3.1:8b";
    this.name = `ollama:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const r = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          { role: "user", content: `Text:\n${text.slice(0, 8000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { message: { content: string } };
    return parseStrictJson(d.message.content);
  }
}

// ── AnthropicExtractor ───────────────────────────────────────────────

export class AnthropicExtractor implements LLMExtractor {
  readonly name: string;
  private apiKey: string;
  private model: string;
  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-3-5-haiku-20241022";
    this.name = `anthropic:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          { role: "user", content: `Text:\n${text.slice(0, 8000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { content: { text: string }[] };
    return parseStrictJson(d.content[0].text);
  }
}

// ── ClaudeCLIExtractor ────────────────────────────────────────────────
//
// v2.14.2+: shells out to the locally-installed `claude` CLI so users on
// OAuth Max plans (no ANTHROPIC_API_KEY) can still use Claude as their
// extractor. The CLI's auth + quota are inherited from the user's session.
//
// Default model is `haiku` (5-10× higher quota than sonnet on Max plan;
// strong enough for grounded extraction without regurgitating few-shot
// demos the way llama3.1:8b does). Override via constructor or
// MEMA_CLAUDE_EXTRACTOR_MODEL env.
//
// Sterilization flags match bench/bench-utils.ts::callClaudeCLI:
//   --no-session-persistence    don't write a resumable session
//   --disable-slash-commands    no skill resolution
//   --allowedTools ""           empty allowlist = no tools
//   --system-prompt <SYSTEM>    OVERRIDE the user's default system prompt
//                               (where CLAUDE.md / PAI persona would load)
//
// MACHTSINN_PORT=65535 in child env so any SessionStart/SessionEnd hooks
// (start.sh / stop.sh) target a throwaway port instead of the real mema
// on 3001.

export class ClaudeCLIExtractor implements LLMExtractor {
  readonly name: string;
  private model: string;
  private timeoutMs: number;
  constructor(opts: { model?: string; timeoutMs?: number } = {}) {
    this.model = opts.model ?? process.env.MEMA_CLAUDE_EXTRACTOR_MODEL ?? "haiku";
    this.timeoutMs = opts.timeoutMs ?? 90000;
    this.name = `claude-cli:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const userPrompt =
      `${FEW_SHOT_USER}\n\n${FEW_SHOT_ASSISTANT}\n\nNow extract from this text:\n${text.slice(0, 8000)}`;
    const proc = Bun.spawn([
      "claude",
      "--model", this.model,
      "--no-session-persistence",
      "--disable-slash-commands",
      "--allowedTools", "",
      "--system-prompt", SYSTEM_PROMPT,
      "-p", userPrompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MACHTSINN_PORT: "65535" },
      cwd: "/tmp",
    });
    const timer = new Promise<"__timeout__">(resolve =>
      setTimeout(() => resolve("__timeout__"), this.timeoutMs));
    const reader = (async () => {
      if (!proc.stdout) return "";
      return new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    })();
    const result = await Promise.race([reader, timer]);
    if (result === "__timeout__") {
      try { proc.kill(); } catch {}
      setTimeout(() => { try { proc.kill(9); } catch {} }, 2000);
      throw new Error(`claude CLI extractor timed out after ${this.timeoutMs}ms`);
    }
    return parseStrictJson(result as string);
  }
}

// ── OpenAIExtractor ──────────────────────────────────────────────────

export class OpenAIExtractor implements LLMExtractor {
  readonly name: string;
  private apiKey: string;
  private model: string;
  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gpt-4o-mini";
    this.name = `openai:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          { role: "user", content: `Text:\n${text.slice(0, 8000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { choices: { message: { content: string } }[] };
    return parseStrictJson(d.choices[0].message.content);
  }
}

// ── Auto-pick ────────────────────────────────────────────────────────
// v2.14.2+ Priority: Anthropic API > Claude CLI (OAuth) > OpenAI > Ollama > throw.
//
// Ollama llama3.1:8b empirically regurgitates few-shot examples instead of
// extracting from the input (verified 2026-05-19 on LongMemEval bench:
// every observe extracted the same 3 prompt-example facts about Marcel/
// machtsinn AG regardless of source content). Demoted from default.
// Force via MEMA_EXTRACTOR env: "ollama" | "anthropic" | "claude_cli" | "openai".

export async function pickExtractor(): Promise<LLMExtractor> {
  const forced = process.env.MEMA_EXTRACTOR?.toLowerCase();
  if (forced === "anthropic" || (!forced && process.env.ANTHROPIC_API_KEY)) {
    return new AnthropicExtractor({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  if (forced === "claude_cli" || forced === "claude-cli"
      || (!forced && await claudeCliAvailable())) {
    return new ClaudeCLIExtractor();
  }
  if (forced === "openai" || (!forced && process.env.OPENAI_API_KEY)) {
    return new OpenAIExtractor({ apiKey: process.env.OPENAI_API_KEY! });
  }
  if (forced === "ollama" || (!forced && await ollamaAvailable())) {
    return new OllamaExtractor();
  }
  throw new Error(
    "No LLM extractor available. Either:\n" +
    "  • install the Claude CLI and log in: brew install claude / claude login\n" +
    "  • set ANTHROPIC_API_KEY or OPENAI_API_KEY\n" +
    "  • install Ollama as fallback: brew install ollama && ollama pull llama3.1:8b\n" +
    "(Ollama is the weakest option — regurgitates few-shot examples.)"
  );
}

async function claudeCliAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const exited = await Promise.race([
      proc.exited,
      new Promise<number>(r => setTimeout(() => r(-1), 2000)),
    ]);
    return exited === 0;
  } catch { return false; }
}

async function ollamaAvailable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
