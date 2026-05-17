// v2.11.1+ — Tests for bench/bench-utils.ts sanitizeEventDate.
//
// The function's behavior is load-bearing for temporal grounding: it must
// NEVER return wall-clock now() (that was the root cause of the
// v2.11.0-rc.1 knowledge-update regression). Tests cover the fall-through
// chain end-to-end, including the "bad raw + bad observationDate" path.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  sanitizeEventDate,
  substringMatch,
  judgePrompt,
  retryVerdict,
  classifyAnswerShape,
  parseCompletenessVerdict,
  retryCompleteness,
} from "../../bench/bench-utils";

describe("sanitizeEventDate", () => {
  let warnCalls: string[] = [];
  let origWarn: typeof console.warn;

  beforeEach(() => {
    warnCalls = [];
    origWarn = console.warn;
    console.warn = (msg: any) => { warnCalls.push(String(msg)); };
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test("returns raw as-is when raw is strict ISO YYYY-MM-DD", () => {
    expect(sanitizeEventDate("2023-05-25", "2026-01-01")).toBe("2023-05-25");
  });

  test("extracts ISO substring from a longer raw string", () => {
    expect(sanitizeEventDate("on 2023-05-25 the user said...", "2026-01-01")).toBe("2023-05-25");
  });

  test("trims whitespace from strict ISO raw", () => {
    expect(sanitizeEventDate("  2023-05-25  ", "2026-01-01")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is undefined", () => {
    expect(sanitizeEventDate(undefined, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is null", () => {
    expect(sanitizeEventDate(null, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is a non-string type", () => {
    expect(sanitizeEventDate(123 as any, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is a prose date with no ISO substring", () => {
    expect(sanitizeEventDate("yesterday morning", "2023-05-25")).toBe("2023-05-25");
  });

  test("coerces YYYY/MM/DD observationDate (LongMemEval format) to YYYY-MM-DD", () => {
    expect(sanitizeEventDate(null, "2023/05/25 (Thu) 20:21")).toBe("2023-05-25");
  });

  test("trims observationDate's leading ISO to 10 chars even with trailing junk", () => {
    expect(sanitizeEventDate(null, "2023-05-25T12:34:56Z")).toBe("2023-05-25");
  });

  test("warns + returns observationDate prefix when both inputs are unparseable", () => {
    const result = sanitizeEventDate("totally bad", "May 25 2023");
    expect(result).toBe("May 25 202");  // first 10 chars
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("unable to parse");
  });

  test("NEVER returns wall-clock today's date — even when both inputs are nonsense, falls back to observationDate prefix",
    () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = sanitizeEventDate("nope", "garbage-input-string");
    // The 10-char prefix of "garbage-input-string" is "garbage-in" — clearly
    // not today's date. The point: we'd rather propagate the caller's
    // (potentially garbage) intent than silently stamp today, which was the
    // v2.11.0-rc.1 bug.
    expect(result).not.toBe(today);
    expect(result).toBe("garbage-in");
  });
});

// ─── substringMatch ─────────────────────────────────────────────────────

describe("substringMatch", () => {
  test("returns true when every significant gold token (>=3 chars) is in predicted", () => {
    expect(substringMatch("Toyota Camry", "user owns Toyota Camry")).toBe(true);
  });

  test("returns false when a significant gold token is missing", () => {
    expect(substringMatch("Toyota Camry Hybrid", "user owns Toyota Camry")).toBe(false);
  });

  test("case-insensitive on both sides", () => {
    expect(substringMatch("TOYOTA", "user owns toyota camry")).toBe(true);
  });

  test("ignores tokens shorter than 3 chars", () => {
    expect(substringMatch("is a Toyota", "It is a TOYOTA.")).toBe(true);
  });

  test("falls back to direct substring when gold has no significant tokens", () => {
    expect(substringMatch("3", "Three items: a, b, c")).toBe(false);
    expect(substringMatch("3", "The count is 3 items")).toBe(true);
  });
});

// ─── judgePrompt ────────────────────────────────────────────────────────

describe("judgePrompt", () => {
  test("includes the benchmark label, question, gold, and predicted", () => {
    const p = judgePrompt("LongMemEval", "What car?", "Toyota Camry", "A Camry");
    expect(p).toContain("LongMemEval");
    expect(p).toContain("What car?");
    expect(p).toContain("Toyota Camry");
    expect(p).toContain("A Camry");
    expect(p).toContain("CORRECT");
    expect(p).toContain("INCORRECT");
  });

  test("different benchmark labels produce distinguishable prompts", () => {
    const lme = judgePrompt("LongMemEval", "q", "g", "p");
    const lcm = judgePrompt("LoCoMo", "q", "g", "p");
    expect(lme).toContain("LongMemEval");
    expect(lcm).toContain("LoCoMo");
    expect(lme).not.toBe(lcm);
  });
});

// ─── retryVerdict ───────────────────────────────────────────────────────

describe("retryVerdict", () => {
  test("returns CORRECT on first attempt when fn returns a CORRECT-prefixed string", async () => {
    let calls = 0;
    const r = await retryVerdict("test", async () => { calls++; return "CORRECT — matches"; }, 3);
    expect(r.verdict).toBe("CORRECT");
    expect(r.reason).toContain("CORRECT");
    expect(calls).toBe(1);
  });

  test("returns INCORRECT on first attempt for INCORRECT-prefixed string", async () => {
    let calls = 0;
    const r = await retryVerdict("test", async () => { calls++; return "INCORRECT: wrong number"; }, 3);
    expect(r.verdict).toBe("INCORRECT");
    expect(calls).toBe(1);
  });

  test("retries on empty response and succeeds on later attempt", async () => {
    let calls = 0;
    const r = await retryVerdict("test", async () => {
      calls++;
      return calls < 2 ? "" : "CORRECT";
    }, 3);
    expect(r.verdict).toBe("CORRECT");
    expect(calls).toBe(2);
  });

  test("returns NO_RESPONSE after exhausting retries when fn always returns empty", async () => {
    let calls = 0;
    const r = await retryVerdict("test", async () => { calls++; return ""; }, 3);
    expect(r.verdict).toBe("NO_RESPONSE");
    expect(r.reason).toContain("empty after 3 retries");
    expect(calls).toBe(3);
  });

  test("returns NO_RESPONSE with ambiguous reason on last attempt if response doesn't classify", async () => {
    const r = await retryVerdict("test", async () => "MAYBE_OK reasoning here", 1);
    expect(r.verdict).toBe("NO_RESPONSE");
    expect(r.reason).toContain("ambiguous");
  });

  test("returns NO_RESPONSE on thrown exception", async () => {
    const r = await retryVerdict("test", async () => { throw new Error("CLI hung"); }, 1);
    expect(r.verdict).toBe("NO_RESPONSE");
    expect(r.reason).toContain("threw");
    expect(r.reason).toContain("CLI hung");
  });

  test("retries on thrown exception then succeeds", async () => {
    let calls = 0;
    const r = await retryVerdict("test", async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "CORRECT";
    }, 3);
    expect(r.verdict).toBe("CORRECT");
    expect(calls).toBe(2);
  });
});

// ─── classifyAnswerShape ────────────────────────────────────────────────

describe("classifyAnswerShape", () => {
  test("returns 'empty' for null", () => {
    expect(classifyAnswerShape(null)).toBe("empty");
  });
  test("returns 'empty' for undefined", () => {
    expect(classifyAnswerShape(undefined)).toBe("empty");
  });
  test("returns 'empty' for whitespace-only string", () => {
    expect(classifyAnswerShape("   \n\t  ")).toBe("empty");
  });

  test("returns 'no-answer' for 'no answer'", () => {
    expect(classifyAnswerShape("no answer")).toBe("no-answer");
  });
  test("returns 'no-answer' for 'I don't know' variants", () => {
    expect(classifyAnswerShape("I don't know the answer.")).toBe("no-answer");
    expect(classifyAnswerShape("I do not know.")).toBe("no-answer");
  });
  test("returns 'no-answer' for 'cannot determine' / 'unable to'", () => {
    expect(classifyAnswerShape("I cannot determine which one.")).toBe("no-answer");
    expect(classifyAnswerShape("Unable to determine from the context.")).toBe("no-answer");
  });
  test("returns 'no-answer' for 'not enough information'", () => {
    expect(classifyAnswerShape("There is not enough information to answer this question.")).toBe("no-answer");
  });

  test("returns 'confident' for a real-looking answer", () => {
    expect(classifyAnswerShape("The user owns a Toyota Camry.")).toBe("confident");
  });
  test("returns 'confident' for short specific answer", () => {
    expect(classifyAnswerShape("25:50")).toBe("confident");
  });
  test("returns 'confident' for answer that contains 'know' but isn't an abstention", () => {
    expect(classifyAnswerShape("I know the answer is Toyota Camry.")).toBe("confident");
  });
});

// ─── parseCompletenessVerdict + retryCompleteness ───────────────────────

describe("parseCompletenessVerdict", () => {
  test("returns 'complete' for COMPLETE prefix", () => {
    expect(parseCompletenessVerdict("COMPLETE — has everything needed")).toBe("complete");
  });
  test("returns 'partial' for PARTIAL prefix", () => {
    expect(parseCompletenessVerdict("PARTIAL: missing the date")).toBe("partial");
  });
  test("returns 'insufficient' for INSUFFICIENT prefix", () => {
    expect(parseCompletenessVerdict("INSUFFICIENT - no relevant info")).toBe("insufficient");
  });
  test("case-insensitive", () => {
    expect(parseCompletenessVerdict("complete and total")).toBe("complete");
  });
  test("trims whitespace", () => {
    expect(parseCompletenessVerdict("  \n  COMPLETE  ")).toBe("complete");
  });
  test("returns 'judge-failed' for unparseable", () => {
    expect(parseCompletenessVerdict("Maybe yes, maybe no")).toBe("judge-failed");
  });
  test("returns 'judge-failed' for null/undefined/empty", () => {
    expect(parseCompletenessVerdict(null)).toBe("judge-failed");
    expect(parseCompletenessVerdict(undefined)).toBe("judge-failed");
    expect(parseCompletenessVerdict("")).toBe("judge-failed");
  });
});

describe("retryCompleteness", () => {
  test("returns complete on first attempt when LLM outputs COMPLETE", async () => {
    let calls = 0;
    const r = await retryCompleteness("test", async () => { calls++; return "COMPLETE — has it"; }, 3);
    expect(r.verdict).toBe("complete");
    expect(calls).toBe(1);
  });
  test("returns partial on PARTIAL output", async () => {
    const r = await retryCompleteness("test", async () => "PARTIAL: missing date", 3);
    expect(r.verdict).toBe("partial");
  });
  test("returns insufficient on INSUFFICIENT output", async () => {
    const r = await retryCompleteness("test", async () => "INSUFFICIENT — nothing relevant", 3);
    expect(r.verdict).toBe("insufficient");
  });
  test("retries on empty and succeeds later", async () => {
    let calls = 0;
    const r = await retryCompleteness("test", async () => {
      calls++;
      return calls < 2 ? "" : "COMPLETE";
    }, 3);
    expect(r.verdict).toBe("complete");
    expect(calls).toBe(2);
  });
  test("returns judge-failed after retries exhausted on empty", async () => {
    const r = await retryCompleteness("test", async () => "", 2);
    expect(r.verdict).toBe("judge-failed");
    expect(r.reason).toContain("empty after 2 retries");
  });
  test("returns judge-failed with ambiguous reason for unparseable last attempt", async () => {
    const r = await retryCompleteness("test", async () => "I think the context is fine", 1);
    expect(r.verdict).toBe("judge-failed");
    expect(r.reason).toContain("ambiguous");
  });
});
