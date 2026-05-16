# Competitor Prompt Intel — verbatim what leading memory systems send to the LLM

**Generated:** 2026-05-17 (post-iteration-2, before v2.11 Memory Compiler implementation)
**Why this exists:** Ardin's call-out — "we did deep dives on the existing leading memory solutions, how did we miss this?" The miss: we read their architecture papers but never their prompts. This doc closes that gap. The compiler step is invisible from architecture diagrams; only verbatim bytes-to-LLM reveal what they actually do.

**Repos cloned to `/tmp/competitor-intel/`:**
- `zep/` — https://github.com/getzep/zep (production app + eval harness)
- `graphiti/` — https://github.com/getzep/graphiti (Zep's underlying temporal KG engine)
- `mem0/` — https://github.com/mem0ai/mem0
- `letta/` — https://github.com/letta-ai/letta (formerly MemGPT)
- `langmem/` — https://github.com/langchain-ai/langmem
- Hindsight: no public OSS repo found at babyagi/hindsight; cloud-only

---

## 1. Zep — the gold standard for the C-mode comparison

**Files:**
- `zep/zep-eval-harness/config/evaluation_config/response_prompt.py` — the system prompt
- `zep/zep-eval-harness/zep_evaluate.py:284-448` — `construct_context_block`, `_format_edges`, `_format_nodes`, `_format_episodes`

### Verbatim system prompt (`response_prompt.py:18-28`)

```
You are an intelligent AI assistant helping a user with their questions.

You have access to the user's conversation history and relevant information in the CONTEXT.

<CONTEXT>
{context}
</CONTEXT>

Using only the information in the CONTEXT, answer the user's questions. Keep responses SHORT - one sentence when possible.
```

### Verbatim context-block format (compiled by `construct_context_block`)

```
# High-level summary of the user
<USER_SUMMARY>
{user_summary}
</USER_SUMMARY>

FACTS, ENTITIES, and EPISODES represent relevant context from the user's knowledge graph.

# These are the most relevant facts about the user
# Facts ending in "present" are currently valid
# Facts with a past end date are NO LONGER VALID.
<FACTS>
{fact_text} (Date range: {valid_at} - {invalid_at})
  Labels: {comma-separated labels}
  Attributes:
    {attr_name}: {attr_value}
    ...

{next_fact} (Date range: ... - ...)
...
</FACTS>

# These are the most relevant entities (people, locations, organizations, items, and more).
<ENTITIES>
Name: {entity_name}
Labels: {labels}
Attributes:
  {attr_name}: {attr_value}
Summary: {entity_summary}

...
</ENTITIES>

# These are the most relevant episodes
<EPISODES>
({created_at}) {episode_content}
...
</EPISODES>
```

(Optional `<DOCUMENT_FACTS>`, `<DOCUMENT_ENTITIES>`, `<DOCUMENT_EPISODES>` sections follow if doc-graph results exist.)

### Key Zep design decisions worth stealing

| Decision | Zep's choice | Why it matters |
|---|---|---|
| **Section wrappers** | XML tags `<FACTS>...</FACTS>` not markdown headers | LLM attention treats XML as structured; markdown can blur into prose. |
| **Inline interpretation hints** | `# Facts ending in "present" are currently valid` BEFORE the data | Teaches the LLM how to read the data in-band, no separate INSTRUCTIONS block needed. |
| **Date-range format** | `(Date range: 2024-07-18 - present)` | Compact + semantic. "present" reads better to LLMs than `invalidated_at: null`. |
| **Per-fact attributes** | Each fact carries `Labels:` + `Attributes:` indented | Carries arbitrary structured metadata beyond subject/predicate/object. |
| **Entity summaries** | Each entity has a `Summary:` field with a narrative | Entities aren't just name+type — they have rich descriptions. |
| **User summary block** | `<USER_SUMMARY>` at top | Distinct from individual facts — a "who is this person" anchor. |
| **Document graph separation** | `<DOCUMENT_FACTS>` vs `<FACTS>` | Keeps "about this user" facts separate from "shared reference docs". |
| **Terse system prompt** | "Keep responses SHORT - one sentence when possible." | LongMemEval / typical bench rewards short answers. |

### What Zep does NOT do (interesting omissions)

- ❌ No explicit `INSTRUCTIONS` block telling the LLM "use current state first" — the inline comments do this job.
- ❌ No `CURRENT STATE` synthesis section — Zep relies on the LLM reading "(Date range: ... - present)" and inferring "this is currently true."
- ❌ No `CONFLICTS / SUPERSESSIONS` section — supersessions are implicit in date ranges.
- ❌ No `UNCERTAINTY` block — Zep trusts the LLM to admit when it doesn't know.
- ❌ No per-question routing visible in the eval harness — same context format for every question.

---

## 2. Mem0 — extraction-first, no compiled context

**Files:**
- `mem0/mem0-ts/src/oss/src/prompts/index.ts:48-275` — `getFactRetrievalMessages` + `getUpdateMemoryMessages`
- Same file:282-768 — `ADDITIVE_EXTRACTION_PROMPT` (V3, much richer)

### Mem0's paradigm

Mem0 does NOT compile a context block for the answer LLM. They:
1. Extract facts from new messages (sophisticated prompts, lots of examples)
2. Run an UPDATE/ADD/DELETE/NONE decision on each fact vs. existing memory
3. Store the resulting memory list
4. **Pass the memory list to the user's agent — but the user owns the answer prompt**

The "answer" prompt is the user's responsibility. Mem0 itself doesn't have a Zep-style `construct_context_block` for answer generation. They surface memories as `[{"id": "0", "text": "..."}, ...]` and the user formats them however they want.

### What Mem0 DOES extremely well

**The extraction prompt (`ADDITIVE_EXTRACTION_PROMPT`) is the most sophisticated thing in any of these repos.** Worth reading in full. Key directives:

1. **"When in doubt, extract."** — A slightly redundant memory is far less costly than a missing one.
2. **Contextually rich, not atomic.** — `Bad: "User has a dog" | Good: "User has a dog named Poppy and their morning walks together are the highlight of their day"`
3. **Temporal grounding** — `"recently"` MUST resolve to absolute date via `Observation Date`. `"User went to Paris last week" is useless 6 months later. "User went to Paris the week of May 15, 2023" is meaningful forever.`
4. **Preserve proper nouns** — `"watched 'Eternal Sunshine of the Spotless Mind'" → KEEP the full title`. Never generalize to `"a movie"`.
5. **No echo extraction** — when assistant restates user fact, don't extract twice.
6. **Memory linking** — new memories carry `linked_memory_ids` to relate to existing memories (same entity, supersession, continuation).
7. **Multi-speaker awareness** — extract from any named speaker, attribute correctly.
8. **Exhaustive extraction checklist** at the end — "If you have fewer than 3 extractions from a 10+ message convo, re-read."

This is where Mem0's quality comes from — not from clever retrieval, but from extraction discipline at write time. **We should port a lot of this into our extractor prompt for v2.13 (Relation-Level Evidence Gate).**

### What Mem0 leaves to the user (= what we have to build ourselves)

- ❌ Compiled context block format
- ❌ Section structure for facts vs episodes
- ❌ Instructions to answer LLM
- ❌ Per-question routing
- ❌ Current-state synthesis

---

## 3. Letta (formerly MemGPT) — agent-loop with editable core memory

**Files:**
- `letta/letta/prompts/system_prompts/react.py` — base ReAct system prompt
- `letta/letta/prompts/prompt_generator.py:26-89` — `compile_memory_metadata_block`

### Letta's paradigm

Letta is **NOT** a context compiler. It's an agent with two memory tiers:
- **Core memory**: editable in-context blocks (`<persona>`, `<human>`, custom blocks) that ALWAYS appear in the system prompt
- **Archival memory**: out-of-context, accessed via tool calls (`archival_memory_search`, `archival_memory_insert`)

The system prompt looks like:

```
<base_instructions>
You are Letta ReAct agent, ...
[long agent behavior instructions]
</base_instructions>

[core memory blocks inlined here — editable by the agent itself]

<memory_metadata>
- AGENT_ID: agent-123
- CONVERSATION_ID: default
- System prompt last recompiled: 2024-01-15 09:00 AM PST
- 42 previous messages between you and the user are stored in recall memory
- 156 total memories you created are stored in archival memory (use tools to access them)
- Available archival memory tags: project_x, meeting_notes, research, ideas
</memory_metadata>
```

For our LongMemEval scenario, Letta's design is **less applicable** — it assumes a long-lived agent that edits its own memory over many turns. LongMemEval is a snapshot benchmark; Letta would have to ingest the entire haystack first via its agent loop. Slow + expensive.

### What Letta DOES well that we could learn from

- **Memory metadata block** — telling the LLM "you have 156 memories accessible via tools" is helpful agent-orchestration context. For our compiled-prompt approach, an UNCERTAINTY-adjacent "you retrieved N facts, M cognitive beliefs, K entities" hint could help.
- **Editable core memory** — for a STREAMING benchmark (our v2.14), this pattern is genuinely interesting. The agent can update its own "what I know about this user" summary as data flows in.

---

## 4. LangMem — toolkit, not a compiler

`langmem/src/langmem/` is a set of LangChain utilities for managing memory: short-term summarization, periodic reflection, tool-based archival. Like Mem0, it doesn't ship a compiled context block — it gives you primitives to build one yourself.

---

## 5. Hindsight — closed source

`babyagi/hindsight` returned 404. The "Hindsight" mentioned in our benchmark (~83.6% on LongMemEval) appears to be a closed-source / research-paper system. We cannot inspect their prompt. Only data point: published benchmark number.

---

## Synthesis — what THIS changes for our v2.11 spec

### Things our v2.11 spec already gets right (validated by Zep)

✅ Sectioned packet (FACTS / ENTITIES / EPISODES / CURRENT STATE / CONFLICTS) — matches Zep's structure conceptually.
✅ Date-aware fact rendering — Zep's `(Date range: ... - present)` is functionally identical to our `valid_from` + `invalidated_at`.
✅ Separate retrieval channels (no displacement) — Zep retrieves edges/nodes/episodes independently, then formats each section from its own pool. Validates our two-channel design.
✅ Explicit instructions to the LLM — Ardin's `INSTRUCTIONS` block is stronger than Zep's inline comments approach; we should keep ours.

### Things our v2.11 spec SHOULD CHANGE based on intel

🔁 **Switch from markdown headers to XML tags.** `<FACTS>...</FACTS>` instead of `# APPROVED FACTS`. Zep uses XML; modern LLMs (Claude especially) are tuned to attend to XML structure.

🔁 **Inline interpretation hints, not just trailing INSTRUCTIONS.** Zep teaches the LLM how to read each section IN-LINE:
- `# Facts ending in "present" are currently valid`
- `# Facts with a past end date are NO LONGER VALID.`

We should do BOTH: inline hints per section AND a final INSTRUCTIONS block. Belt and suspenders.

🔁 **Use "present" not "null" / "unknown".** Cosmetic but real: `(valid_from: 2024-07-18, until: present)` reads better to an LLM than `(valid_from: 2024-07-18, invalidated_at: null)`.

🔁 **Add per-fact `Labels:` and `Attributes:` extensibility.** Our payload currently has `subject/predicate/object/valid_from/invalidated_at`. Zep carries arbitrary structured attributes per fact. We should consider whether confidence, source, governance tags should also surface as attributes. v2.12 work.

🔁 **Add entity SUMMARY field.** Our entities are `{name, type, aliases}`. Zep's entities have a `summary` field with a narrative description. Our extractor doesn't generate entity summaries today. v2.13+ work — but the schema should anticipate it.

🔁 **Add a USER SUMMARY block.** Zep starts with `<USER_SUMMARY>` — a high-level "who is this person" anchor distinct from individual facts. mema's cognitive layer SHOULD produce this organically (one cognitive belief = "user profile: X"). We just need to surface it in the packet. v2.11+ achievable.

### Things our v2.11 spec adds BEYOND Zep (defensible)

✨ **Explicit CURRENT STATE synthesis section** — Zep doesn't have this; relies on LLM to infer from date ranges. Our explicit synthesis MAY be a quality win for temporal questions. Worth benchmarking A/B.

✨ **Explicit CONFLICTS / SUPERSESSIONS section** — Zep doesn't have this; supersessions are implicit. Our explicit narrative MAY help on knowledge-update questions. Worth benchmarking.

✨ **Explicit UNCERTAINTY block** — Zep doesn't have this. Our explicit "the answer LLM should admit not-knowing here" line MAY reduce confabulation. Worth benchmarking.

✨ **Question-type routing** — Zep eval harness uses ONE context format for all questions. Ours plans 4 routing strategies. If routing wins +5pp on hard categories, that's our defensible differentiation.

### Things to definitely STEAL from Mem0 (for v2.13 / extractor work)

🎯 **"When in doubt, extract"** — current mema extractor is conservative. Mem0's directive ("a slightly redundant memory is far less costly than a missing one") + their deduplication step downstream is the better balance.

🎯 **Contextually rich, not atomic** — mema currently generates atomic facts like `User uses_backend sqlite-vec`. Mem0 would generate: `User is using sqlite-vec as the embeddings backend for mema v1.1 because it preserves filesystem-truth`. Richer = more useful for an answer LLM to reason over.

🎯 **Temporal grounding to Observation Date** — port their rule: "recently" must resolve to absolute date.

🎯 **Preserve proper nouns** — port their rule: never generalize "the new restaurant Osteria Francescana" to "a new restaurant".

🎯 **Memory linking** — `linked_memory_ids` field on each new fact relating it to existing memories. This is structurally similar to our `derived_from` chain, but Mem0 captures sideways relations (same topic, contradiction, continuation) — we only capture provenance. Worth extending our schema.

### Key strategic takeaway

**Zep is the closest analog and the right benchmark target.** Their `construct_context_block` is the exact equivalent of what we need to build in v2.11. The mental model: "if Zep can hit 71% on LongMemEval with this format, can mema hit 75-80% with our format extensions (CURRENT STATE / CONFLICTS / UNCERTAINTY / routing)?"

**Mem0 is the model for our extractor (v2.13).** Their extraction prompt is significantly more sophisticated than ours. Porting their guidance is high-leverage extractor-quality work.

**Letta is a different paradigm.** Useful inspiration for the streaming benchmark (v2.14) and for memory metadata hinting, but not directly applicable to the LongMemEval compiled-prompt scenario.

---

## Revised v2.11 Memory Compiler spec (informed by intel)

Update `src/v2/memory-packet.ts` to:
1. **Switch from markdown headers to XML tags** in `compilePacketToPrompt` output
2. **Add inline interpretation hints** per section (Zep pattern)
3. **Add USER_SUMMARY section** sourced from a top cognitive belief (when present)
4. **Render date ranges as "present" not "null"**
5. **Keep CURRENT STATE / CONFLICTS / UNCERTAINTY sections** — these are our defensible differentiators; benchmark them honestly

Update RetrievalHit payload to carry:
- Per-fact `attributes` (placeholder for v2.12; empty for now)
- Per-entity `summary` field (placeholder for v2.13)

Update the 4-mode benchmark plan to add a **5th mode**:
- A. episode-only
- B. flat-mixed (the buggy v2.10.6 design)
- C. memory-packet (our enhanced packet)
- D. routed-packet (memory-packet + routing)
- **E. zep-format-packet** (our retrieval + Zep's exact prompt format, no CURRENT STATE / CONFLICTS / UNCERTAINTY / INSTRUCTIONS) — control variant. If E ≥ C, our extensions don't add value and we should simplify to Zep's format.

This makes the architecture claim DOUBLY defensible:
- C vs A: does structured memory help at all?
- C vs E: do OUR extensions (current state, conflicts, uncertainty, instructions) add value beyond what Zep already does?

---

## Open intel gaps (for next research round)

1. **Hindsight** — closed source; only the published benchmark numbers are available. Can't reverse-engineer their prompt without running their hosted service.
2. **Zep cloud vs OSS** — the eval harness lives in the OSS repo, but Zep cloud may use a different format internally. To verify: run Zep cloud SDK with mitmproxy intercept.
3. **OpenAI Assistants API** memory implementation — closed.
4. **Anthropic claude.ai memory** — closed.

For each: the path to closing the gap is the **competitor-prompt-harness** Ardin asked about — a small bench that runs each SDK against a fixed test question and dumps the actual bytes hitting the LLM. ~1 day of focused work; permanent payoff. **Build this BEFORE the next time we benchmark.**
