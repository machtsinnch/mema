// v2.7+ acceptance lifecycle tests — draft → approved/rejected flow for
// LLM-derived facts and entities. Covers:
//   - back-compat (omitted status = approved)
//   - draft writes (status="draft" + audit op = PROPOSE)
//   - approve/reject transitions + idempotence
//   - retrieval filter (drafts and rejected excluded by default)
//   - evidence check helper

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observe } from "../../src/v2/layer1-episodic";
import {
  recordFact, approveFact, rejectFact, getFactsValidAt,
  listDraftFacts, evidenceCheck, readFact,
} from "../../src/v2/layer2-semantic";
import {
  createEntity, approveEntity, rejectEntity,
  listDraftEntities, listEntities,
} from "../../src/v2/layer2-entities";
import { initAudit, queryAudit, verifyChain } from "../../src/v2/layer6-audit";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v27-"));
  initAudit(dir);
  return dir;
}

describe("v2.7 acceptance lifecycle — facts", () => {
  test("direct write (no status) defaults to approved — back-compat", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Ardin founded machtsinn AG in 2024.",
      actor: "test:writer", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Ardin", predicate: "founded", object: "machtsinn AG",
      derived_from: [ep.id], confidence: 0.95,
      actor: "test:writer", owner: "ardin",
    });
    expect(fact.status).toBe("approved");
    // Visible in default retrieval.
    const at = new Date().toISOString();
    const facts = getFactsValidAt(vault, "ardin", at);
    expect(facts.length).toBe(1);
  });

  test("draft fact is excluded from default retrieval but visible via includeDrafts", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Marcel manages Azure infrastructure.",
      actor: "test:writer", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: [ep.id], confidence: 0.95,
      actor: "test:writer", owner: "ardin",
      status: "draft", proposed_by: "test:extractor",
      evidence_excerpt: "Marcel manages Azure infrastructure.",
    });
    expect(fact.status).toBe("draft");
    expect(fact.proposed_by).toBe("test:extractor");

    const at = new Date().toISOString();
    expect(getFactsValidAt(vault, "ardin", at).length).toBe(0);
    expect(getFactsValidAt(vault, "ardin", at, true).length).toBe(1);

    const drafts = listDraftFacts(vault, "ardin");
    expect(drafts.length).toBe(1);
    expect(drafts[0].id).toBe(fact.id);
  });

  test("approve promotes draft to approved and surfaces in retrieval", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "machtsinn AG uses Cosmos DB for state.",
      actor: "test:writer", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "machtsinn AG", predicate: "uses", object: "Cosmos DB",
      derived_from: [ep.id], confidence: 0.9,
      actor: "test:extractor", owner: "ardin", status: "draft",
    });
    const approved = approveFact(vault, fact.id, "ardin", "test:reviewer", "looks good");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
    expect(approved!.reviewed_by).toBe("test:reviewer");
    expect(approved!.review_reason).toBe("looks good");

    const at = new Date().toISOString();
    expect(getFactsValidAt(vault, "ardin", at).length).toBe(1);
  });

  test("approve is idempotent — second call is a no-op without audit churn", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Ardin uses Bun for the runtime.",
      actor: "t", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Ardin", predicate: "uses", object: "Bun",
      derived_from: [ep.id], confidence: 0.9,
      actor: "t", owner: "ardin", status: "draft",
    });
    approveFact(vault, fact.id, "ardin", "rev", "first");
    const auditAfterFirst = queryAudit({}).filter(a => a.op === "APPROVE").length;
    approveFact(vault, fact.id, "ardin", "rev", "second");
    const auditAfterSecond = queryAudit({}).filter(a => a.op === "APPROVE").length;
    expect(auditAfterSecond).toBe(auditAfterFirst);
  });

  test("reject transitions to rejected and excludes from retrieval", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Some narrative content.",
      actor: "t", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "CHF 22", predicate: "is_a", object: "currency-amount",
      derived_from: [ep.id], confidence: 0.4,
      actor: "ext", owner: "ardin", status: "draft",
    });
    const rejected = rejectFact(vault, fact.id, "ardin", "rev", "subject is currency amount, not entity");
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.review_reason).toContain("currency amount");

    const at = new Date().toISOString();
    // Rejected records excluded even when includeDrafts=true.
    expect(getFactsValidAt(vault, "ardin", at, true).length).toBe(0);
  });

  test("audit chain remains valid across PROPOSE → APPROVE transitions", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Ardin owns machtsinn AG.",
      actor: "t", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Ardin", predicate: "owns", object: "machtsinn AG",
      derived_from: [ep.id], confidence: 0.95,
      actor: "ext", owner: "ardin", status: "draft",
    });
    approveFact(vault, fact.id, "ardin", "rev");
    const proposeOps = queryAudit({}).filter(a => a.op === "PROPOSE");
    const approveOps = queryAudit({}).filter(a => a.op === "APPROVE");
    expect(proposeOps.length).toBe(1);
    expect(approveOps.length).toBe(1);
    const verify = verifyChain();
    expect(verify.valid).toBe(true);
  });
});

describe("v2.7 acceptance lifecycle — entities", () => {
  test("direct entity write defaults to approved", () => {
    const vault = fresh();
    const e = createEntity(vault, {
      name: "Marcel", type: "person",
      actor: "t", owner: "ardin",
    });
    expect(e.status).toBe("approved");
    expect(listEntities(vault, "ardin").length).toBe(1);
  });

  test("draft entity excluded from listEntities; visible via includeDrafts", () => {
    const vault = fresh();
    createEntity(vault, {
      name: "DraftCo", type: "organization",
      actor: "ext", owner: "ardin", status: "draft",
    });
    expect(listEntities(vault, "ardin").length).toBe(0);
    expect(listEntities(vault, "ardin", undefined, true).length).toBe(1);
    expect(listDraftEntities(vault, "ardin").length).toBe(1);
  });

  test("approve + reject transitions on entities", () => {
    const vault = fresh();
    const e1 = createEntity(vault, {
      name: "Real Company", type: "organization",
      actor: "ext", owner: "ardin", status: "draft",
    });
    const e2 = createEntity(vault, {
      name: "garbage-fragment", type: "concept",
      actor: "ext", owner: "ardin", status: "draft",
    });
    approveEntity(vault, e1.id, "ardin", "rev", "valid entity");
    rejectEntity(vault, e2.id, "ardin", "rev", "name is a fragment");
    expect(listEntities(vault, "ardin").length).toBe(1);
    expect(listEntities(vault, "ardin").find(e => e.name === "Real Company")).toBeDefined();
  });
});

describe("v2.7 evidenceCheck helper", () => {
  test("returns ok when subject and object both appear in body", () => {
    const r = evidenceCheck("Ardin", "machtsinn AG", "Ardin founded machtsinn AG in 2024.");
    expect(r.ok).toBe(true);
  });

  test("case-insensitive substring match", () => {
    const r = evidenceCheck("ardin", "MACHTSINN AG", "Ardin founded machtsinn AG in 2024.");
    expect(r.ok).toBe(true);
  });

  test("missing subject", () => {
    const r = evidenceCheck("Marcel", "Azure", "Ardin uses Azure for hosting.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("subject");
  });

  test("missing object", () => {
    const r = evidenceCheck("Ardin", "Heroku", "Ardin uses Azure for hosting.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("object");
  });

  test("both missing", () => {
    const r = evidenceCheck("Bob", "Mars", "Ardin uses Azure for hosting.");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain("subject");
      expect(r.missing).toContain("object");
    }
  });
});

describe("v2.7 readFact preserves lifecycle fields on disk", () => {
  test("draft fact round-trips through readFact with all metadata", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Ardin built mema for Swiss enterprise.",
      actor: "t", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Ardin", predicate: "built", object: "mema",
      derived_from: [ep.id], confidence: 0.95,
      actor: "ext", owner: "ardin",
      status: "draft", proposed_by: "llm-extractor:ollama:llama3.1:8b",
      evidence_excerpt: "Ardin built mema for Swiss enterprise.",
    });
    const round = readFact(vault, "ardin", fact.id);
    expect(round).not.toBeNull();
    expect(round!.status).toBe("draft");
    expect(round!.proposed_by).toBe("llm-extractor:ollama:llama3.1:8b");
    expect(round!.evidence_excerpt).toBe("Ardin built mema for Swiss enterprise.");
  });
});
