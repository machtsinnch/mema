#!/usr/bin/env bun
// v2.11.1+ — Cross-judge the `judge-no-response` cases from a v2.11.0-rc.1
// LongMemEval bench run, using BOTH Claude CLI and Codex CLI plus a
// substring fallback. Outputs a JSONL with per-case verdicts.
//
// WHY: the v2.11.0-rc.1 N=30 bench had 9/90 questions where the Codex
// judge silently returned no response (no error, just empty). The
// harness treats this as score=0. Inspecting predictions showed several
// of these cases produced obviously-correct answers — the "regression"
// in memory-packet's headline number is partly judge infrastructure
// noise, not architecture failure. This tool corrects the record.
//
// Usage:
//   bun bench/rejudge-noresponse.ts
//     # reads /tmp/bench_v211_5mode_{episode-only,memory-packet,zep-format}.jsonl
//     # writes /tmp/rejudge_v211_5mode.jsonl + summary table
//
//   bun bench/rejudge-noresponse.ts --input PATH --output PATH

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import {
  callClaudeCLI,
  callCodexCLI,
  judgePrompt,
  substringMatch,
  retryVerdict,
} from "./bench-utils";

interface QuestionResult {
  question_id: string;
  category: string;
  question: string;
  answer: string;
  predicted_answer?: string;
  judge_score?: number;
  judge_reason?: string;
  [k: string]: any;
}

interface RejudgeResult {
  mode: string;
  question_id: string;
  category: string;
  gold: string;
  predicted: string;
  original_judge_score: number | null;
  original_judge_reason: string;
  claude_verdict: "CORRECT" | "INCORRECT" | "NO_RESPONSE";
  claude_reason: string;
  codex_verdict: "CORRECT" | "INCORRECT" | "NO_RESPONSE";
  codex_reason: string;
  substring_match: boolean;
  consensus: "CORRECT" | "INCORRECT" | "DISPUTED" | "UNRESOLVED";
  consensus_basis: string;
}

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--") && argv[i + 1]) {
    flags[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
}

const MODES = ["episode-only", "memory-packet", "zep-format"];
const INPUT_DIR = "/tmp";
const OUTPUT_PATH = flags.output ?? "/tmp/rejudge_v211_5mode.jsonl";

// v2.11.2+ — callClaudeCLI, callCodexCLI, judgePrompt, substringMatch, and
// retryVerdict all live in bench/bench-utils.ts.

// ─── Main ───────────────────────────────────────────────────────────────

console.error(`[rejudge] loading bench JSONLs from ${INPUT_DIR}/bench_v211_5mode_*.jsonl`);

const allCases: Array<{ mode: string; r: QuestionResult }> = [];
for (const mode of MODES) {
  const path = `${INPUT_DIR}/bench_v211_5mode_${mode}.jsonl`;
  if (!existsSync(path)) {
    console.error(`[rejudge]   skipping ${mode}: ${path} not found`);
    continue;
  }
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const r = JSON.parse(line) as QuestionResult;
    if (r.judge_reason === "judge-no-response") {
      allCases.push({ mode, r });
      count++;
    }
  }
  console.error(`[rejudge]   ${mode}: ${count} judge-no-response cases (of ${lines.length})`);
}

console.error(`[rejudge] total no-response cases to re-judge: ${allCases.length}`);

const results: RejudgeResult[] = [];

for (let i = 0; i < allCases.length; i++) {
  const { mode, r } = allCases[i];
  const gold = r.answer;
  const predicted = r.predicted_answer ?? "";
  console.error(`[rejudge] [${i+1}/${allCases.length}] mode=${mode} qid=${r.question_id} category=${r.category}`);

  const prompt = judgePrompt("LongMemEval", r.question, gold, predicted);

  // Claude (Anthropic) and Codex (OpenAI) are independent providers with
  // independent rate-limit pools. Running them in parallel halves wall
  // time per case (~30s → 15s for 9 cases that's ~4 min saved). The
  // earlier "rate-limit cross-talk" comment was folklore — neither CLI
  // shares a pool with the other.
  console.error(`           → claude + codex (parallel)...`);
  const [claude, codex] = await Promise.all([
    retryVerdict("claude", () => callClaudeCLI(prompt)),
    retryVerdict("codex", () => callCodexCLI(prompt)),
  ]);
  const substr = substringMatch(gold, predicted);

  // Consensus logic (per PRD self-consistency vote — B+C hybrid)
  let consensus: RejudgeResult["consensus"] = "UNRESOLVED";
  let basis = "";
  if (claude.verdict === codex.verdict && claude.verdict !== "NO_RESPONSE") {
    consensus = claude.verdict;
    basis = "two-judge agreement";
  } else if (claude.verdict === "NO_RESPONSE" && codex.verdict !== "NO_RESPONSE") {
    consensus = codex.verdict;
    basis = "codex-only (claude failed)";
  } else if (codex.verdict === "NO_RESPONSE" && claude.verdict !== "NO_RESPONSE") {
    consensus = claude.verdict;
    basis = "claude-only (codex failed)";
  } else if (claude.verdict !== codex.verdict && claude.verdict !== "NO_RESPONSE" && codex.verdict !== "NO_RESPONSE") {
    // Disputed — use substring as tie-breaker
    if (substr) {
      consensus = "CORRECT";
      basis = "tie-broken by substring match";
    } else {
      consensus = "DISPUTED";
      basis = `claude=${claude.verdict} vs codex=${codex.verdict}, substring=fail`;
    }
  } else {
    // Both judges no-response → fall back to substring match
    consensus = substr ? "CORRECT" : "UNRESOLVED";
    basis = "both judges failed; substring " + (substr ? "match" : "miss");
  }

  results.push({
    mode,
    question_id: r.question_id,
    category: r.category,
    gold,
    predicted,
    original_judge_score: typeof r.judge_score === "number" ? r.judge_score : null,
    original_judge_reason: r.judge_reason ?? "",
    claude_verdict: claude.verdict,
    claude_reason: claude.reason,
    codex_verdict: codex.verdict,
    codex_reason: codex.reason,
    substring_match: substr,
    consensus,
    consensus_basis: basis,
  });
  console.error(`           → ${consensus} (${basis})`);
}

// Write JSONL
const lines = results.map(r => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(OUTPUT_PATH, lines);
console.error(`[rejudge] wrote ${results.length} re-judged cases to ${OUTPUT_PATH}`);

// Summary table
console.log("");
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  Cross-judge results — no-response cases from v2.11.0-rc.1 N=30 bench");
console.log("══════════════════════════════════════════════════════════════════════");
console.log("");

for (const mode of MODES) {
  const modeResults = results.filter(r => r.mode === mode);
  if (modeResults.length === 0) continue;
  console.log(`${mode}:`);
  const correct = modeResults.filter(r => r.consensus === "CORRECT").length;
  const wrong = modeResults.filter(r => r.consensus === "INCORRECT").length;
  const disputed = modeResults.filter(r => r.consensus === "DISPUTED").length;
  const unresolved = modeResults.filter(r => r.consensus === "UNRESOLVED").length;
  console.log(`  no-response cases re-judged: ${modeResults.length}`);
  console.log(`  → CORRECT (judge bug masked): ${correct}`);
  console.log(`  → INCORRECT (genuinely wrong): ${wrong}`);
  console.log(`  → DISPUTED (judges disagree):  ${disputed}`);
  console.log(`  → UNRESOLVED:                  ${unresolved}`);
  console.log("");
  for (const r of modeResults) {
    const flag = r.consensus === "CORRECT" ? "✅" :
                 r.consensus === "INCORRECT" ? "❌" :
                 r.consensus === "DISPUTED" ? "⚠️" : "❓";
    console.log(`    ${flag} ${r.question_id} (${r.category})`);
    console.log(`         gold:      ${r.gold.slice(0, 80)}`);
    console.log(`         predicted: ${r.predicted.slice(0, 80)}`);
    console.log(`         claude=${r.claude_verdict} | codex=${r.codex_verdict} | substr=${r.substring_match}`);
    console.log(`         consensus: ${r.consensus} (${r.consensus_basis})`);
  }
  console.log("");
}
