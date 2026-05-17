#!/usr/bin/env bun
// v2.11.0+ — consolidate per-mode LongMemEval JSONLs into a comparison table.
//
// Reads /tmp/bench_v211_5mode_{episode-only,flat-mixed,memory-packet,
// routed-packet,zep-format}.jsonl and emits:
//   1. Overall metrics per mode (Hit@K + Answer-correct)
//   2. Per-category breakdown per mode
//   3. Mode-vs-baseline delta (mode minus episode-only) per category
//   4. Verdict per the v2.11 decision rule:
//      - memory-packet should beat episode-only on hard categories
//      - routed-packet should beat episode-only overall
//      - zep-format provides the control — memory-packet >= zep-format
//        validates mema's extensions
//
// Usage:
//   bun bench/compare-context-modes.ts
//   bun bench/compare-context-modes.ts --json    # JSON output for further processing
//   bun bench/compare-context-modes.ts --dir /custom/path
//
// Output is plain text by default for readability.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { classifyAnswerShape } from "./bench-utils";

interface QuestionResult {
  question_id: string;
  category: string;
  hit_at_1: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
  all_gold_at_10?: boolean;
  coverage_at_10?: number;
  // v2.11.1+ — null means judge infra failed after retries
  judge_score?: number | null;
  judge_reason?: string;
  predicted_answer?: string;
  // v2.11.2+ — LLM answer shape ("no-answer" / "confident" / "empty")
  answer_shape?: "no-answer" | "confident" | "empty";
}

const MODES = [
  "episode-only",
  "flat-mixed",
  "memory-packet",
  "routed-packet",
  "zep-format",
] as const;

type Mode = typeof MODES[number];

function parseArgs() {
  const argv = process.argv.slice(2);
  let dir = "/tmp";
  let json = false;
  // v2.11.1+ — --rejudge PATH overrides judge_score for cases re-judged by
  // bench/rejudge-noresponse.ts. Lets us report corrected metrics without
  // re-running the full bench when only the judge infrastructure flaked.
  let rejudge: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    if (argv[i] === "--dir") dir = argv[++i] ?? dir;
    if (argv[i] === "--rejudge") rejudge = argv[++i] ?? null;
  }
  return { dir, json, rejudge };
}

interface RejudgeEntry {
  mode: string;
  question_id: string;
  consensus: "CORRECT" | "INCORRECT" | "DISPUTED" | "UNRESOLVED";
  consensus_basis: string;
}

function loadRejudge(path: string | null): Map<string, RejudgeEntry> {
  const map = new Map<string, RejudgeEntry>();
  if (!path || !existsSync(path)) return map;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const e = JSON.parse(line) as RejudgeEntry;
    map.set(`${e.mode}:${e.question_id}`, e);
  }
  return map;
}

function loadMode(dir: string, mode: Mode, rejudge: Map<string, RejudgeEntry>): QuestionResult[] | null {
  const path = join(dir, `bench_v211_5mode_${mode}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const results: QuestionResult[] = [];
  for (const l of lines) {
    const r = JSON.parse(l) as QuestionResult;
    // Apply rejudge override if present for this (mode, qid).
    const re = rejudge.get(`${mode}:${r.question_id}`);
    if (re) {
      if (re.consensus === "CORRECT") {
        r.judge_score = 1;
        r.judge_reason = `rejudge:CORRECT (${re.consensus_basis})`;
      } else if (re.consensus === "INCORRECT") {
        r.judge_score = 0;
        r.judge_reason = `rejudge:INCORRECT (${re.consensus_basis})`;
      } else {
        // DISPUTED or UNRESOLVED — leave score=0 but flag the reason
        r.judge_reason = `rejudge:${re.consensus} (${re.consensus_basis})`;
      }
    }
    results.push(r);
  }
  return results;
}

function pct(num: number, den: number): number {
  if (den === 0) return 0;
  return Math.round((num / den) * 1000) / 10;
}

interface ShapeBreakdown {
  correct: number;      // judge_score === 1 (any shape)
  wrongConfident: number;  // judge_score === 0 AND answer_shape === "confident"
  noAnswer: number;     // answer_shape === "no-answer"
  empty: number;        // answer_shape === "empty"
  judgeFailed: number;  // judge_score === null (infra failure)
  unknown: number;      // no judge_score (judging disabled or missing)
}

function emptyShape(): ShapeBreakdown {
  return { correct: 0, wrongConfident: 0, noAnswer: 0, empty: 0, judgeFailed: 0, unknown: 0 };
}

// v2.11.2+ — trichotomy: correct% / wrong-confident% / no-answer% / empty%.
// Defense against INSTRUCTIONS-softening hallucination risk. If a future
// bench shows no-answer% dropping while wrong-confident% rises, the
// softening is trading abstention for confabulation (BAD). If correct%
// rises with no-answer% falling and wrong-confident% steady, the softening
// is unlocking real answers (GOOD).
function classifyRow(r: QuestionResult): keyof ShapeBreakdown {
  if (r.judge_score === null) return "judgeFailed";
  if (r.judge_score === undefined) return "unknown";
  if (r.judge_score === 1) return "correct";
  // judge_score === 0 — distinguish wrong-confident from no-answer.
  // Prefer the harness-recorded answer_shape (v2.11.2+); fall back to
  // re-classifying from predicted_answer for older JSONLs that lack it.
  const shape = r.answer_shape ?? classifyAnswerShape(r.predicted_answer);
  if (shape === "no-answer") return "noAnswer";
  if (shape === "empty") return "empty";
  return "wrongConfident";
}

interface AggregateRow {
  mode: Mode;
  n: number;
  h1: number; h5: number; h10: number;
  allGold: number; cov: number;
  answer: number;
  answerN: number;
  shape: ShapeBreakdown;
  perCategory: Record<string, {
    n: number; h1: number; h5: number; h10: number;
    allGold: number; cov: number;
    answer: number; answerN: number;
    shape: ShapeBreakdown;
  }>;
}

function aggregate(mode: Mode, results: QuestionResult[]): AggregateRow {
  const n = results.length;
  const h1 = results.filter(r => r.hit_at_1).length;
  const h5 = results.filter(r => r.hit_at_5).length;
  const h10 = results.filter(r => r.hit_at_10).length;
  const allGold = results.filter(r => r.all_gold_at_10).length;
  const covSum = results.reduce((s, r) => s + (r.coverage_at_10 ?? 0), 0);
  const judged = results.filter(r => r.judge_score !== undefined && r.judge_score !== null);
  const ansCorrect = judged.filter(r => r.judge_score === 1).length;
  const shape = emptyShape();
  for (const r of results) shape[classifyRow(r)]++;

  const perCategory: AggregateRow["perCategory"] = {};
  const byCat = new Map<string, QuestionResult[]>();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }
  for (const [cat, rows] of byCat) {
    const cn = rows.length;
    const cJudged = rows.filter(r => r.judge_score !== undefined && r.judge_score !== null);
    const cShape = emptyShape();
    for (const r of rows) cShape[classifyRow(r)]++;
    perCategory[cat] = {
      n: cn,
      h1: pct(rows.filter(r => r.hit_at_1).length, cn),
      h5: pct(rows.filter(r => r.hit_at_5).length, cn),
      h10: pct(rows.filter(r => r.hit_at_10).length, cn),
      allGold: pct(rows.filter(r => r.all_gold_at_10).length, cn),
      cov: pct(rows.reduce((s, r) => s + (r.coverage_at_10 ?? 0), 0), cn),
      answer: pct(cJudged.filter(r => r.judge_score === 1).length, cJudged.length),
      answerN: cJudged.length,
      shape: cShape,
    };
  }

  return {
    mode, n,
    h1: pct(h1, n), h5: pct(h5, n), h10: pct(h10, n),
    allGold: pct(allGold, n),
    cov: pct(covSum, n),
    answer: pct(ansCorrect, judged.length),
    answerN: judged.length,
    shape,
    perCategory,
  };
}

function renderText(rows: Map<Mode, AggregateRow>): string {
  const out: string[] = [];

  out.push("══════════════════════════════════════════════════════════════════════");
  out.push("  v2.11 5-mode LongMemEval comparison");
  out.push("══════════════════════════════════════════════════════════════════════");
  out.push("");

  // Overall
  out.push("Overall metrics");
  out.push("  " + "mode".padEnd(18) + "  n   H@1   H@5   H@10  AllG  Cov   Answer%  (judged)");
  out.push("  " + "─".repeat(76));
  for (const mode of MODES) {
    const r = rows.get(mode);
    if (!r) {
      out.push("  " + mode.padEnd(18) + "  (missing)");
      continue;
    }
    out.push(
      "  " + mode.padEnd(18) +
      "  " + String(r.n).padStart(3) +
      "  " + r.h1.toFixed(1).padStart(5) +
      "  " + r.h5.toFixed(1).padStart(5) +
      "  " + r.h10.toFixed(1).padStart(5) +
      "  " + r.allGold.toFixed(1).padStart(4) +
      "  " + r.cov.toFixed(1).padStart(4) +
      "  " + r.answer.toFixed(1).padStart(6) + "  (n=" + r.answerN + ")"
    );
  }
  out.push("");

  // v2.11.2+ — Answer-shape trichotomy. Defense against INSTRUCTIONS-
  // softening hallucination risk. correct% + wrongConfident% + noAnswer%
  // + empty% + judgeFailed% should sum to ~100% per row (modulo
  // unknown%/judge-disabled rows).
  out.push("Answer-shape breakdown (counts; % of N=n)");
  out.push("  " + "mode".padEnd(18) + "  n      correct  wrong-conf   no-answer       empty  judge-fail");
  out.push("  " + "─".repeat(82));
  for (const mode of MODES) {
    const r = rows.get(mode);
    if (!r) continue;
    const cell = (count: number) =>
      `${String(count).padStart(3)} (${pct(count, r.n).toFixed(1).padStart(4)}%)`;
    out.push(
      "  " + mode.padEnd(18) +
      "  " + String(r.n).padStart(3) +
      "  " + cell(r.shape.correct).padStart(11) +
      "  " + cell(r.shape.wrongConfident).padStart(10) +
      "  " + cell(r.shape.noAnswer).padStart(11) +
      "  " + cell(r.shape.empty).padStart(11) +
      "  " + cell(r.shape.judgeFailed).padStart(10)
    );
  }
  out.push("");
  out.push("  Reading guide:");
  out.push("    correct       — judge said CORRECT");
  out.push("    wrong-conf    — LLM gave a confident answer but judge said INCORRECT");
  out.push("    no-answer     — LLM explicitly punted ('I don't know', 'no answer', etc.)");
  out.push("    empty         — LLM returned empty/whitespace");
  out.push("    judge-fail    — judge infra returned no response after retries (score=null)");
  out.push("  Concerning patterns:");
  out.push("    wrong-conf rising vs baseline → softening may be pushing toward confabulation (BAD)");
  out.push("    no-answer dropping + correct rising → softening unlocking real answers (GOOD)");
  out.push("    judge-fail > 0 → re-run with --rejudge after running bench/rejudge-noresponse.ts");
  out.push("");

  // Per-category Answer% (the key metric)
  const allCats = new Set<string>();
  for (const r of rows.values()) {
    for (const cat of Object.keys(r.perCategory)) allCats.add(cat);
  }
  const sortedCats = [...allCats].sort();

  out.push("Answer-correct per category (the key metric)");
  let header = "  " + "category".padEnd(28);
  for (const mode of MODES) header += mode.padStart(15);
  out.push(header);
  out.push("  " + "─".repeat(28 + 15 * MODES.length));
  for (const cat of sortedCats) {
    let line = "  " + cat.padEnd(28);
    for (const mode of MODES) {
      const r = rows.get(mode);
      const c = r?.perCategory[cat];
      if (!c || c.answerN === 0) {
        line += "       n/a".padStart(15);
      } else {
        line += (`${c.answer.toFixed(1)}% (n=${c.answerN})`).padStart(15);
      }
    }
    out.push(line);
  }
  out.push("");

  // Delta vs baseline (episode-only) for Answer%
  const baseline = rows.get("episode-only");
  if (baseline) {
    out.push("Delta vs episode-only baseline (Answer%)");
    out.push("  " + "category".padEnd(28) +
             "flat-mixed".padStart(13) +
             "memory-packet".padStart(15) +
             "routed-packet".padStart(15) +
             "zep-format".padStart(13));
    out.push("  " + "─".repeat(28 + 13 + 15 + 15 + 13));
    for (const cat of sortedCats) {
      const base = baseline.perCategory[cat];
      if (!base) continue;
      let line = "  " + cat.padEnd(28);
      for (const mode of MODES.slice(1)) {  // skip episode-only
        const r = rows.get(mode);
        const c = r?.perCategory[cat];
        if (!c || c.answerN === 0) {
          line += "      n/a".padStart(mode === "memory-packet" || mode === "routed-packet" ? 15 : 13);
        } else {
          const delta = c.answer - base.answer;
          const sign = delta >= 0 ? "+" : "";
          line += (`${sign}${delta.toFixed(1)}pp`).padStart(mode === "memory-packet" || mode === "routed-packet" ? 15 : 13);
        }
      }
      out.push(line);
    }
    out.push("");

    // Overall delta
    out.push("Overall Answer% delta vs episode-only baseline:");
    for (const mode of MODES.slice(1)) {
      const r = rows.get(mode);
      if (!r) continue;
      const delta = r.answer - baseline.answer;
      const sign = delta >= 0 ? "+" : "";
      out.push(`  ${mode.padEnd(18)} ${sign}${delta.toFixed(1)}pp  (${r.answer.toFixed(1)}% vs baseline ${baseline.answer.toFixed(1)}%)`);
    }
    out.push("");

    // Verdict per the v2.11 decision rule
    const mp = rows.get("memory-packet");
    const rp = rows.get("routed-packet");
    const zf = rows.get("zep-format");
    out.push("Decision-rule verdict:");
    if (mp) {
      const delta = mp.answer - baseline.answer;
      out.push(`  memory-packet vs episode-only: ${delta >= 0 ? "✅" : "❌"} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp)`);
    }
    if (rp) {
      const delta = rp.answer - baseline.answer;
      out.push(`  routed-packet vs episode-only: ${delta >= 0 ? "✅" : "❌"} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp) — target ≥ 0pp overall`);
    }
    if (mp && zf) {
      const delta = mp.answer - zf.answer;
      out.push(`  memory-packet vs zep-format:   ${delta >= 0 ? "✅" : "❌"} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp) — mema's extensions earn keep?`);
    }
  }

  return out.join("\n");
}

// ─── main ───────────────────────────────────────────────────────────────

const args = parseArgs();
const rejudge = loadRejudge(args.rejudge);
if (args.rejudge) {
  console.error(`  [info] loaded ${rejudge.size} rejudge overrides from ${args.rejudge}`);
}
const rows = new Map<Mode, AggregateRow>();
for (const mode of MODES) {
  const results = loadMode(args.dir, mode, rejudge);
  if (!results) {
    console.error(`  [warn] no JSONL for mode=${mode} at ${args.dir}`);
    continue;
  }
  rows.set(mode, aggregate(mode, results));
}

if (args.json) {
  const out: Record<string, AggregateRow> = {};
  for (const [mode, row] of rows) out[mode] = row;
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(renderText(rows));
}
