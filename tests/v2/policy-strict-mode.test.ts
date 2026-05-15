// v2.7.3+ strict policy mode + jurisdiction/model-routing tests (P4+P5
// from external review). Covers:
//   - permissive default: missing governance = allow (back-compat)
//   - strict: missing governance = deny
//   - strict: regulated data class without retention = deny
//   - strict: missing purpose on governance = deny
//   - strict: jurisdiction mismatch = deny
//   - model-routing: regulated cloud to wrong-region = deny (both modes)
//   - model-routing: regulated cloud + approved-model allowlist = allow
//   - strict: regulated cloud without human_review = deny

import { describe, expect, test } from "bun:test";
import { policyCheck, buildGovernance, hardErase } from "../../src/v2/layer4-governance";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAudit, queryAudit, verifyChain } from "../../src/v2/layer6-audit";
import matter from "gray-matter";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-policy-"));
  initAudit(dir);
  return dir;
}

describe("v2.7.3 strict policy mode (P4)", () => {
  test("permissive default: missing governance = allow", () => {
    const r = policyCheck(undefined, { actor: "a", purpose: "x" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("no_governance_block");
  });

  test("strict: missing governance = deny", () => {
    const r = policyCheck(undefined, { actor: "a", purpose: "x", mode: "strict" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("strict_no_governance_block");
  });

  test("strict: regulated data class without retention = deny", () => {
    const gov = buildGovernance({
      source_content: "patient profile",
      actor: "ingestor",
      purpose: ["clinical_care"],
      data_classes: ["health"],
      // no retention_until
    });
    const r = policyCheck(gov, { actor: "a", purpose: "clinical_care", mode: "strict" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("strict_regulated_missing_retention");
  });

  test("strict: regulated data class WITH retention = pass", () => {
    const gov = buildGovernance({
      source_content: "x",
      actor: "i",
      purpose: ["clinical_care"],
      data_classes: ["health"],
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, { actor: "a", purpose: "clinical_care", mode: "strict" });
    expect(r.allowed).toBe(true);
  });

  test("strict: governance with empty purpose array = deny", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: [],
    });
    const r = policyCheck(gov, { actor: "a", purpose: "anything", mode: "strict" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("strict_governance_missing_purpose");
  });

  test("strict: jurisdiction mismatch = deny", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"], jurisdiction: "CH",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support", mode: "strict", jurisdiction: "US",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("strict_jurisdiction_mismatch");
  });

  test("strict: matching jurisdiction = pass", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"], jurisdiction: "CH",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support", mode: "strict", jurisdiction: "ch",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("v2.7.3 model-routing policy (P5)", () => {
  test("regulated content to unapproved cloud region = deny (permissive)", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["personal"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support",
      model: { model: "kimi-cloud", model_region: "unknown", deployment: "cloud" },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("model_routing_denied");
  });

  test("regulated content to matching cloud region = pass (permissive)", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["personal"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support",
      model: { model: "swiss-llm", model_region: "CH", deployment: "cloud" },
    });
    expect(r.allowed).toBe(true);
  });

  test("regulated content + approved-model allowlist = pass (permissive)", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["financial"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support",
      model: {
        model: "claude-haiku-4-5", model_region: "US", deployment: "cloud",
        approved_models: ["claude-haiku-4-5"],
      },
    });
    expect(r.allowed).toBe(true);
  });

  test("local deployment = pass for regulated content", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["personal"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support",
      model: { model: "ollama:llama3.1:8b", deployment: "local" },
    });
    expect(r.allowed).toBe(true);
  });

  test("strict: regulated cloud without human_review = deny", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["health"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support", mode: "strict", jurisdiction: "CH",
      model: { model: "swiss-llm", model_region: "CH", deployment: "cloud" },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("strict_regulated_cloud_requires_human_review");
  });

  test("strict: regulated cloud WITH human_review = pass", () => {
    const gov = buildGovernance({
      source_content: "x", actor: "i", purpose: ["support"],
      data_classes: ["health"], jurisdiction: "CH",
      retention_until: "2099-01-01T00:00:00Z",
    });
    const r = policyCheck(gov, {
      actor: "a", purpose: "support", mode: "strict", jurisdiction: "CH",
      model: {
        model: "swiss-llm", model_region: "CH", deployment: "cloud",
        human_review: true,
      },
    });
    expect(r.allowed).toBe(true);
  });
});

describe("v2.7.2 hard-erase audit provenance (P6)", () => {
  test("ERASE captures content + metadata hashes and original record_id", () => {
    const vault = fresh();
    // Write a record with frontmatter + body.
    const dir = join(vault, "facts", "ardin");
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    const recordPath = join(dir, "test-fact--01ABCDEFGHIJKLMNOPQRSTUVWX.md");
    const original = matter.stringify("# Subject pred Object\n\nbody content", {
      id: "01ABCDEFGHIJKLMNOPQRSTUVWX",
      owner: "ardin",
      subject: "Subject",
      predicate: "pred",
      object: "Object",
    });
    writeFileSync(recordPath, original, "utf8");

    const result = hardErase({
      vaultRoot: vault,
      owner: "ardin",
      record_path: recordPath,
      actor: "operator:ardin",
      reason: "DSAR-erasure-request-2026-05-15",
      legal_basis: "GDPR_Article_17",
    });

    expect(result.erased).toBe(true);
    expect(result.tombstone_id).toBeDefined();
    expect(result.erased_record_id).toBe("01ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(result.content_hash_before).toMatch(/^[a-f0-9]{64}$/);
    expect(result.metadata_hash_before).toMatch(/^[a-f0-9]{64}$/);

    // Tombstone written to disk; original content destroyed.
    expect(existsSync(recordPath)).toBe(true);
    const tomb = matter(readFileSync(recordPath, "utf8"));
    expect(tomb.data.tombstone).toBe(true);
    expect(tomb.data.content_hash_before).toBe(result.content_hash_before);
    expect(tomb.content).not.toContain("body content");

    // Audit entry carries the structured metadata.
    const audit = queryAudit({ op: "ERASE" });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const meta = audit[0].metadata as any;
    expect(meta.erased_record_id).toBe("01ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(meta.content_hash_before).toBe(result.content_hash_before);
    expect(meta.metadata_hash_before).toBe(result.metadata_hash_before);
    expect(meta.legal_basis).toBe("GDPR_Article_17");

    // Hash chain still verifies despite the new metadata field.
    expect(verifyChain().valid).toBe(true);
  });
});
