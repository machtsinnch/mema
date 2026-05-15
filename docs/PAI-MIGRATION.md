# PAI Memory → mema Migration Design

**Status**: Design (not implemented)
**Owner**: Ardin
**Target release**: mema v2.2.0 + PAI patch
**Date**: 2026-05-15

---

## 1. Goal

Replace PAI's filesystem-only memory store with mema as the backing storage,
without losing existing memories, without slowing down PAI session boot, and
with a clean rollback path if anything regresses.

Success criteria:

1. Every existing PAI memory file is represented as a mema v2 record after migration.
2. PAI's CLAUDE.md "auto memory" workflow reads/writes via mema's HTTP API.
3. The original `.md` files remain on disk during a soak period (rollback-safe).
4. Recall latency in PAI session boot is ≤ 200 ms (same order as filesystem reads today).
5. Audit trail: every read and write is recorded in mema's hash-chained log.
6. No functional regression — every PAI workflow that used the old memory keeps working.

---

## 2. Current state (PAI memory today)

```
~/.claude/projects/-Users-ardin-Documents-pai/memory/
├── MEMORY.md                              # index, one line per memory
├── user_ardin_role.md                     # type: user
├── feedback_research_default.md           # type: feedback
├── feedback_machtsinn_principles.md       # type: feedback
├── feedback_classify_findings.md          # type: feedback
├── project_machtsinn_memory.md            # type: project
├── project_machtsinn_v1_1_roadmap.md      # type: project
├── project_machtsinn_scorecard_ceilings.md
├── project_machtsinn_v2_six_layer.md
└── reference_machtsinn_paths.md           # type: reference
```

Each file has frontmatter like:
```yaml
---
name: user-ardin-role
description: "Ardin is a founder..."
metadata:
  node_type: memory
  type: user
  originSessionId: 17c4a31c-...
---
Body content here. May contain [[wikilinks]] to other memories.
```

PAI's CLAUDE.md auto-memory section instructs the agent to:
- Read `MEMORY.md` at session start
- Read individual `.md` files when relevant
- Write new memories by creating new `.md` files and adding a line to `MEMORY.md`

---

## 3. Target state (after migration)

PAI memories live as mema **L3 cognitive records** (mutable, confidence-weighted,
supports supersession). The original `.md` files become read-only references for
audit/rollback.

```
PAI session boot:
  ↓
  POST /v2/recall  (semantic + keyword over all PAI memories)
  ↓
  Returns top-K memories most relevant to the current task

PAI saves a new memory:
  ↓
  POST /v2/cognitive  (kind=belief|observation, content, derived_from=[session])
  ↓
  Stored in data/cognitive/ardin/{kind}/{ulid}.md
  ↓
  appendAudit  ─→ data/_meta/audit.sqlite + audit-witness.log

PAI updates a memory:
  ↓
  POST /v2/cognitive/{old_id}/supersede  (creates a new record, links old → new)
```

The Obsidian graph view (v2.1.0) shows the memory network natively.

---

## 4. Mapping

### 4.1 PAI memory type → mema cognitive kind

| PAI type | mema kind | Rationale |
|---|---|---|
| `user` | `belief` | A claim about the user that the agent holds and can update |
| `feedback` | `belief` | A rule the user expressed that the agent commits to |
| `project` | `observation` | Something the agent noticed about a project's state |
| `reference` | `observation` | A pointer to external resources observed at a moment |

All four map to L3 because PAI memories are **mutable** (supersession + edit), which
is precisely what L3 supports and L1/L2 don't.

### 4.2 Field-by-field mapping

| PAI frontmatter | mema field | Notes |
|---|---|---|
| `name` | first alias / used as record title | Slug-style, e.g. `user-ardin-role` |
| `description` | second alias / search bait | The one-line hook |
| `metadata.type` | mapped to `kind` (see 4.1) | |
| `metadata.originSessionId` | `governance.evidence.source_id` | Preserves provenance |
| `metadata.node_type: memory` | dropped (always `cognitive`) | |
| body | record `content` | Verbatim |
| `[[wikilinks]]` in body | preserved as-is in body | Obsidian renders them; v2 graph walks `derived_from` separately |

### 4.3 Cross-memory links

PAI memories reference each other via `[[name-slug]]` wikilinks in the body
(e.g., `Related: [[project-machtsinn-memory]]`). During migration we:

1. First pass: import every memory and record its mema ID + original slug.
2. Second pass: walk each memory's body, find `[[slug]]` references, resolve
   each slug to the mema ID, populate `derived_from: [...mema_ids]` on the
   cognitive record. This makes the v2 graph view show the connections
   without rewriting the bodies.

### 4.4 Entity

All PAI memories belong to entity `pai-self` (a single synthetic entity that
represents "the user's working knowledge about themselves and their own work").
This keeps the multi-tenant model intact while not over-fragmenting.

### 4.5 Owner

`ardin` (single tenant for personal-use mema).

### 4.6 Retention

PAI memories are persistent by default. Don't set `retention_until`. Time-bound
memories (e.g., "stop doing X for the next 7 days") get explicit retention via
the new write path; the migration treats existing memories as indefinite.

---

## 5. Migration script

`scripts/migrate-pai-memory.ts` — one-shot, idempotent, dry-run support.

```bash
# Preview
bun scripts/migrate-pai-memory.ts \
  --source ~/.claude/projects/-Users-ardin-Documents-pai/memory \
  --api http://localhost:3001 \
  --key dev-ardin \
  --dry-run

# Run
bun scripts/migrate-pai-memory.ts \
  --source ~/.claude/projects/-Users-ardin-Documents-pai/memory \
  --api http://localhost:3001 \
  --key dev-ardin
```

Pseudocode:
```
1. Read MEMORY.md → list of memory files with descriptions.
2. For each file:
   a. Parse frontmatter + body.
   b. Skip MEMORY.md itself.
   c. Map type → kind via table 4.1.
   d. POST /v2/cognitive { kind, content: body, confidence: 0.9, derived_from: [] }
      (derived_from filled in pass 2).
   e. Record slug → mema_id in a local map.
3. Second pass: for each migrated record, scan body for [[slug]] references,
   resolve to mema_ids, POST update to add derived_from list. (Note: this
   requires a new PATCH /v2/cognitive/:id endpoint — not yet built; can be
   approximated by writing a new cognitive record with the right links and
   calling supersede on the original. Or add a small targeted endpoint.)
4. Emit a summary CSV: original_path,mema_id,slug,kind,derived_from_count.
```

Idempotency: re-running the script checks for an existing mema record with the
same `source_id` (== PAI's `originSessionId` + filename) and skips writes.

---

## 6. CLAUDE.md changes

The auto-memory section of `~/.claude/CLAUDE.md` is rewritten. Three sub-sections:

### 6.1 Read at session start
```
When you start a session in this project, call:
  POST http://localhost:3001/v2/recall
  Body: { query: "{first user message excerpt or 'session boot'}",
          purpose: "session-boot",
          kinds: ["cognitive"],
          limit: 10 }
Pass the top-K recalled memories into your context as system background.
```

### 6.2 Write a new memory
```
When you learn something durable about the user or the project:
  POST http://localhost:3001/v2/cognitive
  Body: { kind: "belief"|"observation", content: "...",
          confidence: 0.8, derived_from: ["{session_id}"] }
```

### 6.3 Update / supersede
```
When a memory is wrong or outdated:
  POST http://localhost:3001/v2/cognitive   (write the new one)
  POST http://localhost:3001/v2/cognitive/{old_id}/supersede  { new_id }
```

The instructions are short and concrete; PAI's existing memory-shape rules
(feedback structure, why/how-to-apply pattern) still apply to the content
written into mema.

---

## 7. Hook integration

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      "curl -s http://localhost:3001/health > /dev/null || ~/Projects/machtsinn.ai/scripts/start.sh"
    ]
  }
}
```

Already present today — no change needed beyond the existing mema-start hook.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Migration fails halfway, leaves partial state in mema | Idempotent script; safe to re-run. Original files stay on disk. |
| HTTP recall on session start adds latency to every Claude Code session | Measured at 96% P@1 in <50 ms on local-hash embedder; well within the 200 ms budget. If exceeded, fall back to filesystem until investigated. |
| mema server is down at session start | SessionStart hook auto-starts mema. If still down, PAI's CLAUDE.md should have a fallback clause: "if /health fails, read MEMORY.md as before." This degrades gracefully. |
| The body of a memory contains `[[unresolved-slug]]` after migration | Migration script reports unresolved slugs as warnings; manual review pass before considering migration complete. |
| PAI's recall heuristic returns the wrong memories under semantic retrieval | Compare against the manual file-read baseline for one week. If quality drops, rollback (see §9). |
| Auditing every recall slows session boot | Audit is append-only with hash chain; benchmarked < 1 ms per write. Negligible. |

---

## 9. Rollback plan

The original `.md` files in `~/.claude/projects/-Users-ardin-Documents-pai/memory/`
stay on disk untouched throughout the migration and the soak period (≥ 2 weeks).
Rollback steps:

1. Revert the CLAUDE.md auto-memory section to its previous filesystem-only form.
2. (Optional) Use `POST /v2/erase` on migrated records to remove the duplicates
   from mema, or just leave them — they coexist harmlessly.
3. No data loss because the original files were never deleted.

---

## 10. Open questions

1. **Should PAI memories live under a separate owner?** (e.g., `ardin-pai` to
   keep PAI's working memory distinct from machtsinn-customer corpora when
   you're testing on the employer notebook.) Lean: yes, use `ardin-pai`.

2. **Should new memories be auto-wrapped as L7 verifiable assets?** (Each
   record gets a UAL + content hash on write.) Lean: yes for PAI memories —
   they're personal records you may want to export or anchor later.

3. **Is a small extraction LLM call worth it on write?** PAI memories
   already follow a structured shape (rule + why + how-to-apply). They're
   pre-extracted. No LLM call needed at write time — preserves the
   "no-LLM-on-write" invariant.

4. **What's the entity discipline?** Lean: `pai-self` for personal,
   per-project entities only when a memory is unambiguously about one
   specific machtsinn or customer project.

5. **Do `[[wikilinks]]` in PAI memory bodies get resolved during recall to
   include the linked records in the result?** This is the "graph
   expansion at recall" feature mema already has in v2.1. Should already
   work after migration.

---

## 11. Implementation plan (when approved)

| Order | Change | Effort |
|---|---|---|
| 1 | Add `PATCH /v2/cognitive/:id` to merge new `derived_from` IDs into an existing record (or use supersede + new record) | 1 hr |
| 2 | `scripts/migrate-pai-memory.ts` (passes 1 and 2) + dry-run + reporting | 2 hr |
| 3 | Test migration end-to-end on a copy of the PAI memory dir, verify Obsidian graph shows the network | 1 hr |
| 4 | Run migration for real with `--dry-run` confirmation | 15 min |
| 5 | Rewrite the CLAUDE.md auto-memory section to use mema endpoints | 30 min |
| 6 | Add a fallback clause: "if mema is unavailable, fall back to filesystem read" | 15 min |
| 7 | Soak period: 2 weeks of dogfood, measure recall accuracy vs filesystem baseline | passive |
| 8 | If soak passes: archive the old `.md` files (move to `memory.legacy/`). If fails: rollback per §9. | 15 min |

Total active work: ~5 hours. Soak period: 2 weeks.

---

## 12. Approval gate

This design is **not yet implemented**. Approve scope before any code change:
- Confirm mappings in §4
- Confirm script approach in §5
- Confirm CLAUDE.md change shape in §6
- Confirm rollback strategy in §9
- Resolve open questions in §10
