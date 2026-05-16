// v2.11.0 — Memory Packet Compiler tests.
//
// Coverage:
//   1. `rules` predicates (isCurrent, isSuperseded, isConflicting, inclusion rules)
//   2. `buildMemoryPacket` constructs all sections from a two-channel hits input
//   3. `compilePacketToPrompt` renders the canonical XML + inline-hints format
//   4. `compilePacketAsZepFormat` renders the control format (no extensions)
//   5. `classifyAnswerStrategy` returns the expected strategy per rule path

import { describe, expect, test } from "bun:test";

import {
  rules,
  buildMemoryPacket,
  compilePacketToPrompt,
  compilePacketAsZepFormat,
  classifyAnswerStrategy,
  type TwoChannelHits,
} from "../../src/v2/memory-packet";
import type { RetrievalHit } from "../../src/v2/types";

// ─── Fixtures ────────────────────────────────────────────────────────────

function factHit(opts: {
  id?: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  invalidated_at?: string;
  confidence?: number;
}): RetrievalHit {
  return {
    kind: "fact",
    id: opts.id ?? "01FACT" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    score: 0.5,
    score_components: {
      idf: 0.5, title: 0, vector: 0,
      confidence: opts.confidence ?? 0.9,
      layerPrior: 0.9, graph_support: 0, recency: 0.5, contradiction: 0,
    },
    excerpt: `${opts.subject} ${opts.predicate} ${opts.object}`,
    governance: { allowed: true, reason: "no_governance_block" },
    payload: {
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object,
      valid_from: opts.valid_from,
      ...(opts.invalidated_at ? { invalidated_at: opts.invalidated_at } : {}),
    },
  };
}

function cognitiveHit(opts: {
  id?: string;
  content: string;
  kind?: "belief" | "observation" | "experience";
  confidence?: number;
}): RetrievalHit {
  return {
    kind: "cognitive",
    id: opts.id ?? "01COG" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    score: 0.5,
    score_components: {
      idf: 0.5, title: 0, vector: 0,
      confidence: opts.confidence ?? 0.85,
      layerPrior: 1.0, graph_support: 0, recency: 0.5, contradiction: 0,
    },
    excerpt: opts.content.slice(0, 240),
    governance: { allowed: true, reason: "no_governance_block" },
    payload: {
      content: opts.content,
      cognitive_kind: opts.kind ?? "belief",
      ...(typeof opts.confidence === "number" ? { confidence: opts.confidence } : {}),
    },
  };
}

function entityHit(opts: {
  id?: string;
  name: string;
  type: string;
  aliases?: string[];
}): RetrievalHit {
  return {
    kind: "entity",
    id: opts.id ?? "01ENT" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    score: 0.5,
    score_components: {
      idf: 0.5, title: 0, vector: 0,
      confidence: 1.0, layerPrior: 0.6, graph_support: 0, recency: 0.5, contradiction: 0,
    },
    excerpt: `${opts.name} (${opts.type})`,
    governance: { allowed: true, reason: "no_governance_block" },
    payload: {
      name: opts.name,
      entity_type: opts.type,
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
    },
  };
}

function episodeHit(opts: {
  id?: string;
  excerpt: string;
}): RetrievalHit {
  return {
    kind: "episode",
    id: opts.id ?? "01EP" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    score: 0.5,
    score_components: {
      idf: 0.5, title: 0, vector: 0,
      confidence: 0.9, layerPrior: 0.7, graph_support: 0, recency: 0.5, contradiction: 0,
    },
    excerpt: opts.excerpt,
    governance: { allowed: true, reason: "no_governance_block" },
  };
}

// ─── Rule predicates ─────────────────────────────────────────────────────

describe("rules.isCurrent", () => {
  test("returns true for a fact whose valid_from is before the query date and not invalidated", () => {
    const f = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.isCurrent(f, "2024-08-12")).toBe(true);
  });

  test("returns false for a fact with invalidated_at set", () => {
    const f = factHit({
      subject: "u", predicate: "owns", object: "Civic",
      valid_from: "2024-01-01", invalidated_at: "2024-07-18",
    });
    expect(rules.isCurrent(f, "2024-08-12")).toBe(false);
  });

  test("returns false for a fact whose valid_from is after the query date", () => {
    const f = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2025-01-01" });
    expect(rules.isCurrent(f, "2024-08-12")).toBe(false);
  });

  test("returns true defensively when valid_from is missing", () => {
    const f = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "" });
    expect(rules.isCurrent(f, "2024-08-12")).toBe(true);
  });
});

describe("rules.isSuperseded", () => {
  test("returns true when invalidated_at is set", () => {
    const f = factHit({
      subject: "u", predicate: "owns", object: "Civic",
      valid_from: "2024-01-01", invalidated_at: "2024-07-18",
    });
    expect(rules.isSuperseded(f)).toBe(true);
  });

  test("returns false when invalidated_at is not set", () => {
    const f = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.isSuperseded(f)).toBe(false);
  });
});

describe("rules.isConflicting", () => {
  test("returns true for two facts with same subject+predicate but different objects", () => {
    const a = factHit({ subject: "u", predicate: "owns", object: "Civic", valid_from: "2024-01-01" });
    const b = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.isConflicting(a, b)).toBe(true);
  });

  test("returns false when subjects differ", () => {
    const a = factHit({ subject: "u1", predicate: "owns", object: "Civic", valid_from: "2024-01-01" });
    const b = factHit({ subject: "u2", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.isConflicting(a, b)).toBe(false);
  });

  test("returns false when objects are the same", () => {
    const a = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-01-01" });
    const b = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.isConflicting(a, b)).toBe(false);
  });
});

describe("rules.includeInCurrentState", () => {
  test("includes a current, non-superseded fact", () => {
    const f = factHit({ subject: "u", predicate: "owns", object: "Camry", valid_from: "2024-07-18" });
    expect(rules.includeInCurrentState(f, "2024-08-12")).toBe(true);
  });

  test("excludes a superseded fact even if its valid_from precedes the query date", () => {
    const f = factHit({
      subject: "u", predicate: "owns", object: "Civic",
      valid_from: "2024-01-01", invalidated_at: "2024-07-18",
    });
    expect(rules.includeInCurrentState(f, "2024-08-12")).toBe(false);
  });
});

describe("rules.selectUserSummary", () => {
  test("returns undefined when there are no cognitive hits", () => {
    expect(rules.selectUserSummary([])).toBeUndefined();
  });

  test("picks the highest-confidence belief with usable content", () => {
    const lower = cognitiveHit({
      content: "User prefers Italian food when dining out with family on weekends.",
      confidence: 0.7,
    });
    const higher = cognitiveHit({
      content: "User is a software engineer in Zurich working primarily on memory systems.",
      confidence: 0.95,
    });
    const picked = rules.selectUserSummary([lower, higher]);
    expect(picked).toContain("software engineer");
  });

  test("skips beliefs with content shorter than 20 chars", () => {
    const tooShort = cognitiveHit({ content: "Likes tea.", confidence: 0.99 });
    const usable = cognitiveHit({ content: "User works on memory-systems research at a startup in Zurich.", confidence: 0.5 });
    const picked = rules.selectUserSummary([tooShort, usable]);
    expect(picked).toContain("memory-systems");
  });
});

// ─── buildMemoryPacket ───────────────────────────────────────────────────

describe("buildMemoryPacket", () => {
  test("builds a packet with all sections from a two-channel input", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [
        episodeHit({ excerpt: "user said they bought a Camry on July 18 2024" }),
        episodeHit({ excerpt: "user mentioned considering a Civic earlier in 2024" }),
      ],
      memory_channel: [
        factHit({
          subject: "user", predicate: "owns", object: "Honda Civic",
          valid_from: "2024-01-01", invalidated_at: "2024-07-18", confidence: 0.85,
        }),
        factHit({
          subject: "user", predicate: "owns", object: "Toyota Camry",
          valid_from: "2024-07-18", confidence: 0.94,
        }),
        cognitiveHit({
          content: "User prefers reliability over performance in vehicles.",
          kind: "belief", confidence: 0.8,
        }),
        entityHit({ name: "Toyota Camry", type: "product", aliases: ["Camry"] }),
      ],
    };
    const packet = buildMemoryPacket({
      query: "What car does the user currently have?",
      question_date: "2024-08-12",
      question_type: "temporal-reasoning",
      hits,
    });

    expect(packet.query).toBe("What car does the user currently have?");
    expect(packet.question_date).toBe("2024-08-12");
    expect(packet.answer_strategy).toBe("temporal_state");

    // CURRENT_STATE — only the Camry (Civic is superseded)
    expect(packet.current_state.length).toBe(1);
    expect(packet.current_state[0].object).toBe("Toyota Camry");

    // FACTS — both, sorted by valid_from
    expect(packet.approved_facts.length).toBe(2);
    expect(packet.approved_facts[0].object).toBe("Honda Civic");
    expect(packet.approved_facts[1].object).toBe("Toyota Camry");
    expect(packet.approved_facts[0].invalidated_at).toBe("2024-07-18");

    // COGNITIVE_BELIEFS
    expect(packet.cognitive_beliefs.length).toBe(1);
    expect(packet.cognitive_beliefs[0].content).toContain("reliability");

    // ENTITIES
    expect(packet.entities.length).toBe(1);
    expect(packet.entities[0].name).toBe("Toyota Camry");
    expect(packet.entities[0].aliases).toContain("Camry");

    // EVIDENCE_TIMELINE — chronological
    expect(packet.evidence_timeline.length).toBe(2);
    expect(packet.evidence_timeline[0].date).toBe("2024-01-01");
    expect(packet.evidence_timeline[1].date).toBe("2024-07-18");

    // CONFLICTS — Civic supersession
    expect(packet.conflicts.length).toBe(1);
    expect(packet.conflicts[0].narrative).toContain("Honda Civic");
    expect(packet.conflicts[0].narrative).toContain("2024-07-18");

    // USER_SUMMARY — picked from the belief
    expect(packet.user_summary).toContain("reliability");

    // RAW_SUPPORTING_EXCERPTS — both episodes
    expect(packet.raw_supporting_excerpts.length).toBe(2);

    // PROVENANCE
    expect(packet.provenance.length).toBeGreaterThanOrEqual(3);  // 2 facts + 1 cognitive
  });

  test("UNCERTAINTY is surfaced when no structured memory was retrieved", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [episodeHit({ excerpt: "some raw text" })],
      memory_channel: [],
    };
    const packet = buildMemoryPacket({
      query: "What does the user like?",
      hits,
    });
    expect(packet.uncertainty.length).toBeGreaterThan(0);
    expect(packet.uncertainty[0]).toContain("No structured memory");
  });

  test("UNCERTAINTY is surfaced for a temporal question with no current state", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [],
      memory_channel: [
        // valid_from is AFTER the question date — no current state.
        factHit({
          subject: "user", predicate: "moved_to", object: "Berlin",
          valid_from: "2025-06-01",
        }),
      ],
    };
    const packet = buildMemoryPacket({
      query: "Where does the user currently live?",
      question_date: "2024-08-12",
      hits,
    });
    expect(packet.answer_strategy).toBe("temporal_state");
    expect(packet.uncertainty.some(u => u.includes("current state"))).toBe(true);
  });
});

// ─── compilePacketToPrompt (XML + inline hints, mema-full) ───────────────

describe("compilePacketToPrompt", () => {
  test("renders all sections with XML wrappers and inline hints", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [episodeHit({ excerpt: "(2024-07-18) user bought a Camry" })],
      memory_channel: [
        factHit({
          subject: "user", predicate: "owns", object: "Toyota Camry",
          valid_from: "2024-07-18", confidence: 0.94,
        }),
        cognitiveHit({ content: "User values reliability in cars.", confidence: 0.8 }),
        entityHit({ name: "Toyota Camry", type: "product", aliases: ["Camry"] }),
      ],
    };
    const packet = buildMemoryPacket({
      query: "What car does the user currently have?",
      question_date: "2024-08-12",
      question_type: "temporal-reasoning",
      hits,
    });
    const rendered = compilePacketToPrompt(packet);

    // Structure markers
    expect(rendered).toContain("<QUESTION_DATE>2024-08-12</QUESTION_DATE>");
    expect(rendered).toContain("<QUERY>What car does the user currently have?</QUERY>");
    expect(rendered).toContain("<CURRENT_STATE>");
    expect(rendered).toContain("</CURRENT_STATE>");
    expect(rendered).toContain("<FACTS>");
    expect(rendered).toContain("<COGNITIVE_BELIEFS>");
    expect(rendered).toContain("<ENTITIES>");
    expect(rendered).toContain("<RAW_SUPPORTING_EXCERPTS>");
    expect(rendered).toContain("<INSTRUCTIONS>");

    // Inline hints
    expect(rendered).toContain("# CURRENT_STATE represents claims the system believes are TRUE NOW");
    expect(rendered).toContain('# Facts ending in "present" are currently valid');
    expect(rendered).toContain("# COGNITIVE_BELIEFS are inferences");
    expect(rendered).toContain("# Named entities relevant to the query.");

    // Date range format
    expect(rendered).toContain("(Date range: 2024-07-18 - present, confidence: 0.94)");

    // Instructions content
    expect(rendered).toContain("Answer using CURRENT_STATE first");
    expect(rendered).toContain("Do not treat COGNITIVE_BELIEFS as facts");
  });

  test("omits sections that are empty (no `<FACTS></FACTS>` boilerplate)", () => {
    const packet = buildMemoryPacket({
      query: "Anything you know?",
      hits: { evidence_channel: [], memory_channel: [] },
    });
    const rendered = compilePacketToPrompt(packet);

    expect(rendered).toContain("<QUERY>");
    expect(rendered).toContain("<INSTRUCTIONS>");
    // No empty sections
    expect(rendered).not.toContain("<FACTS>");
    expect(rendered).not.toContain("<COGNITIVE_BELIEFS>");
    expect(rendered).not.toContain("<CURRENT_STATE>");
    expect(rendered).not.toContain("<ENTITIES>");
  });

  test("renders an invalidated fact with the invalidation date inline", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [],
      memory_channel: [
        factHit({
          subject: "user", predicate: "lives_in", object: "Zurich",
          valid_from: "2020-01-01", invalidated_at: "2024-03-15", confidence: 0.9,
        }),
      ],
    };
    const packet = buildMemoryPacket({ query: "Where does the user live?", hits });
    const rendered = compilePacketToPrompt(packet);
    expect(rendered).toContain("(Date range: 2020-01-01 - 2024-03-15");
    expect(rendered).toContain("Earlier claim");  // CONFLICTS section
  });

  test("can disable the INSTRUCTIONS section (for control-mode renders)", () => {
    const packet = buildMemoryPacket({
      query: "hi",
      hits: { evidence_channel: [], memory_channel: [] },
    });
    const rendered = compilePacketToPrompt(packet, { includeInstructions: false });
    expect(rendered).not.toContain("<INSTRUCTIONS>");
  });
});

// ─── compilePacketAsZepFormat (control variant) ──────────────────────────

describe("compilePacketAsZepFormat", () => {
  test("renders FACTS / ENTITIES / EPISODES sections only — no mema extensions", () => {
    const hits: TwoChannelHits = {
      evidence_channel: [episodeHit({ excerpt: "(2024-07-18) user bought a Camry" })],
      memory_channel: [
        factHit({
          subject: "user", predicate: "owns", object: "Toyota Camry",
          valid_from: "2024-07-18", confidence: 0.94,
        }),
        entityHit({ name: "Toyota Camry", type: "product", aliases: ["Camry"] }),
        // Cognitive beliefs are NOT rendered in Zep format.
        cognitiveHit({ content: "User values reliability.", confidence: 0.8 }),
      ],
    };
    const packet = buildMemoryPacket({
      query: "What car does the user currently have?",
      question_date: "2024-08-12",
      hits,
    });
    const rendered = compilePacketAsZepFormat(packet);

    expect(rendered).toContain("<FACTS>");
    expect(rendered).toContain("<ENTITIES>");
    expect(rendered).toContain("<EPISODES>");
    expect(rendered).toContain("(Date range: 2024-07-18 - present)");

    // mema-specific extensions ABSENT
    expect(rendered).not.toContain("<CURRENT_STATE>");
    expect(rendered).not.toContain("<COGNITIVE_BELIEFS>");
    expect(rendered).not.toContain("<CONFLICTS>");
    expect(rendered).not.toContain("<UNCERTAINTY>");
    expect(rendered).not.toContain("<INSTRUCTIONS>");
  });
});

// ─── classifyAnswerStrategy ──────────────────────────────────────────────

describe("classifyAnswerStrategy", () => {
  test("question_type wins over query heuristic", () => {
    expect(classifyAnswerStrategy({
      query: "what does the user prefer?",
      question_type: "knowledge-update",
    })).toBe("knowledge_update");
  });

  test("temporal_state for 'currently'", () => {
    expect(classifyAnswerStrategy({ query: "What does the user currently own?" })).toBe("temporal_state");
  });

  test("preference for 'prefer'", () => {
    expect(classifyAnswerStrategy({ query: "What kind of cuisine does the user prefer?" })).toBe("preference");
  });

  test("knowledge_update for 'changed'", () => {
    expect(classifyAnswerStrategy({ query: "When did the user change their car?" })).toBe("knowledge_update");
  });

  test("multi_session for 'across'", () => {
    expect(classifyAnswerStrategy({ query: "What topics has the user mentioned across sessions?" })).toBe("multi_session");
  });

  test("direct_episode default fallback", () => {
    expect(classifyAnswerStrategy({ query: "What is the meaning of life?" })).toBe("direct_episode");
  });
});
