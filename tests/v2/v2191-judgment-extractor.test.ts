// v2.19.1 — judgment extraction parsing (no CLI/network in tests).

import { describe, expect, test } from "bun:test";
import { parseJudgmentProposal } from "../../src/v2/llm-judgment-extractor";

describe("parseJudgmentProposal", () => {
  test("parses a full proposal", () => {
    const p = parseJudgmentProposal(JSON.stringify({
      found: true,
      question: "Keep type inheritance?",
      decision: "Remove it; keep the model flat",
      rationale: "Costs outweigh benefits",
      alternatives: [{ option: "keep inheritance", reason_rejected: "adapter complexity" }],
      consequences: ["attributes repeated"],
      status: "proposed",
      supersedes_refs: ["ADR-15", "ADR-16"],
      supersession_reason: "benefits not proportional to cost",
    }))!;
    expect(p.status).toBe("proposed");
    expect(p.supersedes_refs).toEqual(["ADR-15", "ADR-16"]);
    expect(p.alternatives).toHaveLength(1);
  });

  test("found:false → null (document without a decision)", () => {
    expect(parseJudgmentProposal('{"found":false}')).toBeNull();
  });

  test("survives fences; defaults status to accepted; null reason when none", () => {
    const p = parseJudgmentProposal('```json\n{"found":true,"question":"q","decision":"d","rationale":"r"}\n```')!;
    expect(p.status).toBe("accepted");
    expect(p.supersedes_refs).toEqual([]);
    expect(p.supersession_reason).toBeNull();
  });

  test("rejects missing core fields and junk", () => {
    expect(() => parseJudgmentProposal('{"found":true,"question":"q","decision":""}')).toThrow();
    expect(() => parseJudgmentProposal("not json")).toThrow();
  });
});
