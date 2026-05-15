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

const FEW_SHOT_USER = `Text:
Marcel founded machtsinn AG in 2024. The company uses Azure for infrastructure. Customer A rejected the Pro tier because they only need Starter.`;

const FEW_SHOT_ASSISTANT = `{
  "facts": [
    {"subject": "Marcel", "predicate": "founded", "object": "machtsinn AG", "confidence": 0.95},
    {"subject": "machtsinn AG", "predicate": "uses", "object": "Azure", "confidence": 0.95},
    {"subject": "Customer A", "predicate": "rejected", "object": "Pro tier", "confidence": 0.9}
  ],
  "entities": [
    {"name": "Marcel", "type": "person"},
    {"name": "machtsinn AG", "type": "organization"},
    {"name": "Azure", "type": "system"},
    {"name": "Customer A", "type": "organization"},
    {"name": "Pro tier", "type": "product"}
  ]
}`;

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
  return {
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    entities: Array.isArray(obj.entities) ? obj.entities : [],
  };
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
// Priority: Ollama (local, free, private) → Anthropic → OpenAI → throw.
// User can force via MEMA_EXTRACTOR env var: "ollama" | "anthropic" | "openai".

export async function pickExtractor(): Promise<LLMExtractor> {
  const forced = process.env.MEMA_EXTRACTOR?.toLowerCase();
  if (forced === "ollama" || (!forced && await ollamaAvailable())) {
    return new OllamaExtractor();
  }
  if (forced === "anthropic" || (!forced && process.env.ANTHROPIC_API_KEY)) {
    return new AnthropicExtractor({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  if (forced === "openai" || (!forced && process.env.OPENAI_API_KEY)) {
    return new OpenAIExtractor({ apiKey: process.env.OPENAI_API_KEY! });
  }
  throw new Error(
    "No LLM extractor available. Install Ollama (recommended):\n" +
    "  brew install ollama\n" +
    "  ollama serve &\n" +
    "  ollama pull llama3.1:8b\n" +
    "OR set ANTHROPIC_API_KEY or OPENAI_API_KEY."
  );
}

async function ollamaAvailable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
