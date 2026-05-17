// v2.11.1+ — tests for the harness's judgeWithRetry path.
//
// Full LLM-retry mocking would require stubbing Bun.spawn; for now, the
// substring path is unit-tested (covers the score-0/1 return contract and
// the reason-text format). The LLM retry/fallback path is exercised
// end-to-end by the rejudge tool against real CLIs.

import { describe, expect, test } from "bun:test";
import { judgeWithRetry } from "../../bench/longmemeval-harness";

function baseArgs(over: Partial<any> = {}): any {
  return {
    judge: "substring",
    judgeBackend: "claude",
    judgeModel: "test-model",
    answerBackend: "claude",
    ollamaHost: "http://localhost:11434",
    api: "http://localhost:3002",
    key: "test",
    owner: "test",
    contextChars: 200000,
    topK: 10,
    ...over,
  };
}

describe("judgeWithRetry — substring branch", () => {
  test("returns score=1 + substring-match when all significant gold tokens appear in predicted", async () => {
    const r = await judgeWithRetry(
      baseArgs(),
      "What car?",
      "Toyota Camry",
      "The user owns the Toyota Camry.",
    );
    expect(r.score).toBe(1);
    expect(r.reason).toBe("substring-match");
  });

  test("returns score=0 + substring-miss when a significant gold token is missing", async () => {
    const r = await judgeWithRetry(
      baseArgs(),
      "What car?",
      "Toyota Camry Hybrid",
      "The user owns the Toyota Camry.",
    );
    expect(r.score).toBe(0);
    expect(r.reason).toBe("substring-miss");
  });

  test("ignores tokens shorter than 3 chars in the gold (case-insensitive)", async () => {
    // gold "is a Toyota" has "is" + "a" + "Toyota" — only "Toyota" should count.
    const r = await judgeWithRetry(
      baseArgs(),
      "What is it?",
      "is a Toyota",
      "It is a TOYOTA.",
    );
    expect(r.score).toBe(1);
  });
});

describe("judgeWithRetry — disabled branch", () => {
  test("returns score=0 + judge-disabled when args.judge is neither 'substring' nor 'llm'", async () => {
    const r = await judgeWithRetry(
      baseArgs({ judge: "none" }),
      "What?", "anything", "nothing",
    );
    expect(r.score).toBe(0);
    expect(r.reason).toBe("judge-disabled");
  });
});
