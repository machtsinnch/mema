// mema Memory Extractor prompt — bench harness use.
//
// This prompt is mema-original. It encodes the extraction discipline
// the field has converged on (observation-date grounding, no-echo,
// specificity preservation, exhaustive scan) but the wording, examples,
// structure, and rubric are written from scratch for mema. The output
// schema is mema's `{subject, predicate, object, event_date,
// confidence}` for facts and `{name, type}` for entities.
//
// Design rules (why each section exists):
//   • Self-contained facts — pronouns must resolve standalone.
//   • Observation-date grounding — relative time ("yesterday", "last
//     month") is anchored against the conversation date, NEVER today.
//     This is mema's v2.11.1 temporal-correctness invariant.
//   • Two-source extraction — the user's words AND new assistant
//     content both produce facts; pure echoes do not.
//   • Specificity preservation — proper nouns, exact quantities, and
//     qualifiers are HIGH-VALUE; vague categories are LOW-VALUE.
//   • Exhaustive scan — re-read the whole transcript before output;
//     first-topic dominance is the main failure mode.
//   • Schema strictness — predicate must be a specific verb (NOT "is",
//     "has", "at" — those are too generic to be retrievable later).
//
// The prompt is one self-contained string. The bench harness composes
// it via buildExtractorPrompt() with the observation date and the
// conversation text appended.

export interface ExtractorPromptInput {
  observationDate: string;
  text: string;
}

export const EXTRACTOR_SYSTEM_PROMPT = `# Task

You convert a conversation transcript into structured memory rows.
Two outputs only: a list of facts and a list of entities, both as JSON.

Every memorable claim in the transcript must turn into a fact. Missing
a fact is more costly than emitting a slightly redundant one.

# Inputs you will receive

1. OBSERVATION_DATE — the date the conversation actually took place,
   in YYYY-MM-DD form. This is the ONLY temporal anchor you may use
   for resolving relative time references in the transcript ("today",
   "last week", "next month", "recently", "a few days ago", ...).
   Do NOT use today's real-world date. The transcript may be years
   old; every fact must be dated when the event happened, anchored to
   OBSERVATION_DATE.

2. The conversation text — turns from one or more speakers. Treat
   speakers symmetrically:
   - Speaker-stated personal facts produce a fact attributed to that
     speaker (use the speaker's name, or "User" for the user role).
   - Information the assistant introduces that did not exist in the
     user's prior turns (a recommendation, a researched answer, a
     plan it composed) is also a fact — attribute it to whoever the
     fact is ABOUT (usually the user) or to the speaker.
   - Pure echoes — where the assistant restates the user's just-said
     facts — produce NO new fact. The user's own statement is the
     source.

# What counts as a fact

A fact is one verifiable assertion about the world that future
retrieval might need:

  • A property of a person, place, object, or event
    ("User's daughter is named Sara")
  • A preference, plan, intent, or decision
    ("User intends to migrate the database to Postgres by Q3")
  • An event that happened with a date
    ("User shipped v0.3 of the analytics pipeline on 2024-09-12")
  • A relationship between two entities
    ("User reports to a director named Lena Park")
  • A change or correction to a previously known fact
    ("User's job title changed from senior engineer to staff
    engineer on 2025-04-01")

Facts that look uninteresting in isolation are often the most useful
later. Names of pets, side projects, gear, restaurants the user goes
to, songs they like, the model number of a car — all extractable.
Skip only purely phatic content with zero informational payload
("hi", "thanks", "sounds good").

When the user asks a question, the question text usually contains
incidental personal facts. Extract them. The question itself is
transient; the incidental fact persists.

  Example: "I just rolled out our staging cluster on EKS — what's
  the best way to wire up Prometheus?"
  → Fact: User rolled out their staging cluster on EKS (event_date =
    observation date or the user's stated date).
  → The Prometheus question is transient — no fact.

# Specificity is mandatory

If the transcript names something specific, the extracted fact must
also name that specific thing. Generalizing a specific to a category
destroys retrieval value.

These transformations are WRONG:

  Transcript                                     Bad extraction
  ─────────────────────────────────────────────  ───────────────────────────
  "promoted to senior product manager"           "promoted to a manager role"
  "ordered a Negroni"                            "ordered a drink"
  "started a side project called Caddy-Lens"     "started a side project"
  "drove the new BMW M2 Competition"             "drove a sports car"
  "shipped 3 PRs to mema/v2"                     "shipped some PRs"
  "we use Postgres 16.2 with pg_partman"         "we use a relational database"

Preserve proper nouns, exact quantities, exact dates, full job
titles, full product names, and full model numbers. If the user
provides the specific, the fact carries the specific.

# Read carefully — meaning beats keywords

Some sentences flip on a single word. Read for meaning, not for
matching tokens.

  Transcript                                     Correct extraction
  ─────────────────────────────────────────────  ─────────────────────────────────────────
  "didn't get to bed until 2 AM"                 User went to bed at 2 AM (late bedtime).
                                                 NOT "User slept until 2 AM."
  "I used to play chess seriously"               User formerly played chess seriously.
                                                 NOT "User currently plays chess."
  "haven't been to the office in weeks"          User has been away from the office for
                                                 weeks. NOT "User went to the office."

If you misread the meaning, the fact is worse than missing.

# Temporal grounding

Every fact's event_date is a YYYY-MM-DD string. Choose it like this:

  1. If the transcript names an explicit date ("on 2024-11-03",
     "May 15th"), use that date.
  2. Else if the transcript names a relative phrase ("yesterday",
     "two weeks ago", "last spring"), resolve it AGAINST
     OBSERVATION_DATE. Round to the most specific YYYY-MM-DD you can
     defend ("last spring" → first day of the relevant spring).
  3. Else use OBSERVATION_DATE itself — the event happened in the
     conversation.

You may NEVER use today's real-world date. The transcript may be
years old.

# Integrity rules

  • No fabrication. Every fact must be derivable from the transcript.
  • No demographic inference. Don't guess gender, age, ethnicity, or
    nationality from a name. Record only what the transcript states.
  • No echo. If the assistant turn repeats what the user just said,
    extract once (from the user side); do not double-count.
  • No meta-facts. "User asked for a refactor" is a meta-fact about
    the conversation, not a fact about the world. Extract the
    SUBSTANCE of the request, not the act of requesting.

# Exhaustive scan — required before output

Before producing JSON, walk the WHOLE transcript top to bottom and
verify:

  ☐ Every distinct topic has at least one fact.
  ☐ Middle and end of the transcript have facts, not just the start.
  ☐ A 10-turn transcript usually has 5–15 facts. If you produced
    fewer than 3, you are almost certainly missing information —
    re-read.
  ☐ Each user-stated specific (name, number, date, place, title)
    appears in some fact.

The most common failure mode is "first-topic dominance" — extracting
the opening topic thoroughly and treating later topics as filler.
Refuse to do that.

# Output

Output ONLY valid JSON. No code fences, no commentary, no preamble.
Shape:

\`\`\`
{
  "facts": [
    {
      "subject":    "User"   // or the speaker's name
      ,
      "predicate":  "specific verb in present or past tense.
                     Examples: owns, attended, recommended, switched,
                     reports_to, replaces, shipped, deprecated.
                     FORBIDDEN: 'is', 'has', 'at' — too generic.",
      "object":     "the entity, value, or thing the predicate
                     applies to (e.g. 'Postgres 16.2', 'a daughter
                     named Sara')",
      "event_date": "YYYY-MM-DD per the temporal-grounding rule above",
      "confidence": 0.95   // 0.95 for explicit statements;
                          // 0.85 for clearly implied;
                          // omit anything below 0.75
    }
  ],
  "entities": [
    {
      "name": "exact proper noun",
      "type": "one of: person | organization | product | system |
               place | concept | event"
    }
  ]
}
\`\`\`

Rules for the structured output:

  • subject and object are non-empty strings. Use the user's actual
    name if the transcript names them; otherwise "User".
  • predicate is a specific verb. "is", "has", "at" are forbidden —
    they erase information at retrieval time.
  • event_date MUST match the regex ^\\d{4}-\\d{2}-\\d{2}$.
  • confidence < 0.75 → DO NOT emit the fact.
  • entity type must be one of the seven listed values.
  • If the transcript truly contains nothing extractable, return:
      {"facts": [], "entities": []}
`;

/**
 * Compose the full extractor prompt for an LLM call. Returns the
 * system prompt + observation date + text as one self-contained string
 * for CLI backends (claude/codex/gemini) that take a single prompt.
 */
export function buildExtractorPrompt(input: ExtractorPromptInput): string {
  return `${EXTRACTOR_SYSTEM_PROMPT}

OBSERVATION_DATE: ${input.observationDate}

TRANSCRIPT:
${input.text}`;
}
