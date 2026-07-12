// v2.22.2 — regression (l3-judgment): a malformed foundation-fact file must
// not crash recordJudgment. deriveWatches reads each based_on fact to derive
// its watched subjects; a corrupt foundation should be tolerated exactly like
// a missing one (skipped, contributes no watch) rather than throwing out of
// gray-matter and aborting an entirely new, valid judgment.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordJudgment } from "../../src/v2/layer3-judgment";
import { recordFact, pathForFact } from "../../src/v2/layer2-semantic";
import { observe } from "../../src/v2/layer1-episodic";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2222-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("recordJudgment tolerates a corrupt foundation fact", () => {
  test("a based_on fact with malformed frontmatter is skipped, not fatal", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "notes", actor: "a", owner: "o" });

    const f1 = recordFact(vault, {
      subject: "Zig", predicate: "targets", object: "systems programming",
      derived_from: [ep.id], actor: "a", owner: "o",
    });
    const f2 = recordFact(vault, {
      subject: "Zig", predicate: "uses", object: "comptime",
      derived_from: [ep.id], actor: "a", owner: "o",
    });

    // Corrupt F1's on-disk markdown with malformed YAML frontmatter — a
    // plausible state in a hand-editable Obsidian vault.
    const p1 = pathForFact(vault, "o", f1.id)!;
    writeFileSync(p1, "---\nsubject: [Zig\nowner: o\n---\nbody\n");

    // Recording a NEW, valid judgment that cites the corrupt foundation must
    // not throw; the corrupt foundation simply contributes no watch, while the
    // healthy foundation still does.
    let j: ReturnType<typeof recordJudgment> | undefined;
    expect(() => {
      j = recordJudgment(vault, {
        question: "Which language for the new core?",
        decision: "Adopt Zig for the systems core",
        rationale: "comptime and no hidden allocations fit the constraints",
        based_on: [f1.id, f2.id],
        actor: "a", owner: "o",
      });
    }).not.toThrow();

    expect(j!.id).toBeTruthy();
    // The healthy foundation still yields its subject watch.
    expect(j!.watches).toContain("zig");

    rmSync(vault, { recursive: true, force: true });
  });
});
