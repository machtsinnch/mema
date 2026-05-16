#!/usr/bin/env bun
// Error-class auditor for LongMemEval harness results (v2.10.5+).
//
// Reads a JSONL produced by `longmemeval-harness.ts --save-results <path>`
// and buckets each FAILED question (judge_score = 0) into one of the seven
// failure categories the third-party diagnostic identified:
//
//   1. context_missing            — gold session not in retrieval top-K
//   2. retrieval_incomplete       — some gold sessions in top-K, but not all
//                                    (coverage_at_10 < 1)
//   3. context_present_no_answer  — full context present but model said
//                                    "no answer" → model_failed (reasoning)
//   4. model_failed_wrong_answer  — predicted answer != gold and is not
//                                    "no answer"; reasoning error
//   5. judge_wrong_semantic_match — predicted contains every gold token but
//                                    judge still marked incorrect → judge bias
//   6. temporal_ordering_missing  — temporal-reasoning category + answer
//                                    looks like wrong-era info
//   7. memory_structure_missing   — preference category + answer looks like
//                                    literal quote rather than abstraction
//
// Usage:
//   bun bench/lme-error-audit.ts /tmp/lme_v210_5_baseline.jsonl
//   bun bench/lme-error-audit.ts /tmp/lme_v210_5_ablation.jsonl

import { readFileSync, existsSync } from "node:fs";

type FailureClass =
  | "context_missing"
  | "retrieval_incomplete"
  | "context_present_no_answer"
  | "model_failed_wrong_answer"
  | "judge_wrong_semantic_match"
  | "temporal_ordering_missing"
  | "memory_structure_missing";

interface Row {
  question_id: string;
  category: string;
  question: string;
  answer: string;
  predicted_answer?: string;
  judge_score?: number;
  judge_reason?: string;
  hit_at_10: boolean;
  all_gold_at_10: boolean;
  coverage_at_10: number;
}

function classify(r: Row): FailureClass {
  if (!r.hit_at_10) return "context_missing";
  if (!r.all_gold_at_10) return "retrieval_incomplete";
  const pred = (r.predicted_answer ?? "").toLowerCase().trim();
  if (pred === "no answer" || pred === "" || pred === '"no answer"') {
    return "context_present_no_answer";
  }
  // Semantic check — does predicted contain every gold ≥3-char token?
  const goldTokens = r.answer.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (goldTokens.length > 0 && goldTokens.every(w => pred.includes(w))) {
    return "judge_wrong_semantic_match";
  }
  if (r.category === "temporal-reasoning") return "temporal_ordering_missing";
  if (r.category === "single-session-preference") return "memory_structure_missing";
  return "model_failed_wrong_answer";
}

function main() {
  const path = process.argv[2];
  if (!path || !existsSync(path)) {
    console.error("usage: lme-error-audit.ts <results.jsonl>");
    process.exit(1);
  }
  const rows: Row[] = readFileSync(path, "utf8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  const judged = rows.filter(r => r.judge_score !== undefined);
  const failed = judged.filter(r => r.judge_score === 0);

  const total = judged.length;
  const correct = judged.filter(r => r.judge_score === 1).length;
  console.log(`File: ${path}`);
  console.log(`Total judged: ${total}  Correct: ${correct}  Failed: ${failed.length}  Accuracy: ${(correct/total*100).toFixed(1)}%`);
  console.log("");

  // Bucket failures by class.
  const buckets = new Map<FailureClass, Row[]>();
  for (const r of failed) {
    const c = classify(r);
    const arr = buckets.get(c) ?? [];
    arr.push(r);
    buckets.set(c, arr);
  }
  console.log("Failure classes:");
  console.log("  " + "class".padEnd(34) + " count  pct-of-failures  pct-of-all");
  console.log("  " + "─".repeat(72));
  for (const [c, arr] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pctOfFail = (arr.length / failed.length * 100).toFixed(1);
    const pctOfAll = (arr.length / total * 100).toFixed(1);
    console.log(`  ${c.padEnd(34)} ${String(arr.length).padStart(4)}  ${pctOfFail.padStart(8)}%  ${pctOfAll.padStart(8)}%`);
  }
  console.log("");

  // Per-category failure breakdown.
  const byCat = new Map<string, Map<FailureClass, number>>();
  for (const r of failed) {
    const c = classify(r);
    const m = byCat.get(r.category) ?? new Map<FailureClass, number>();
    m.set(c, (m.get(c) ?? 0) + 1);
    byCat.set(r.category, m);
  }
  console.log("Per-category failure mix:");
  for (const [cat, m] of [...byCat.entries()].sort()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${cat} (${total} failures):`);
    for (const [c, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${c.padEnd(34)} ${String(n).padStart(3)}`);
    }
  }
  console.log("");

  // Show 3 sample failures per class for spot-checking.
  console.log("Sample failures per class (3 each):");
  for (const [c, arr] of buckets) {
    console.log(`\n  --- ${c} ---`);
    for (const r of arr.slice(0, 3)) {
      console.log(`  Q: ${r.question}`);
      console.log(`  GOLD: ${r.answer}`);
      console.log(`  PRED: ${(r.predicted_answer ?? "").slice(0, 200)}`);
      console.log(`  JUDGE: ${(r.judge_reason ?? "").slice(0, 100)}`);
      console.log("");
    }
  }
}

main();
