#!/usr/bin/env python3
"""
Recall benchmark: compare mema v1 /v1/recall vs v2 /v2/recall on a curated set of
questions over the user's imported corpus (finance-plan + machtsinn business folder).

Methodology:
  1. For each query, define expected_keywords that the correct top-hit's alias SHOULD contain.
  2. Hit both endpoints, capture top-1 and top-5.
  3. Score:
       - precision@1: does top-1's alias contain at least one expected keyword? (1 or 0)
       - precision@5: fraction of top-5 hits whose alias contains an expected keyword
       - has_relevant_in_top5: at least one of the top-5 is relevant (binary)
  4. Aggregate across queries, compare v1 vs v2.

The "expected keywords" are intentionally specific — they describe what document
should win for each question. This makes the eval reproducible without needing
an LLM judge for this baseline.
"""
import json
import urllib.request
import statistics
from typing import Optional

API_KEY = "dev-ardin"
BASE = "http://localhost:3001"

QUERIES = [
    # (label, query, expected_keywords_in_alias)
    ("Q01", "Säule 3a Pillar 3a strategy", ["pillar 3a", "säule 3a", "swiss tax"]),
    ("Q02", "concentration position sizing strategy", ["concentration", "position sizing"]),
    ("Q03", "antifragile portfolio bear markets", ["antifragile", "anti-fragile", "bear market"]),
    ("Q04", "megatrend artificial intelligence aging population", ["megatrend"]),
    ("Q05", "pricing page positioning value communication", ["pricing", "positioning"]),
    ("Q06", "competitive positioning analysis", ["competitive", "positioning"]),
    ("Q07", "machtsinn elevator pitch value proposition", ["pitch", "value", "positioning"]),
    ("Q08", "US go-to-market strategy", ["go-to-market", "us", "gtm"]),
    ("Q09", "deployment model impact assessment", ["deployment", "impact"]),
    ("Q10", "founder decision pack", ["founder", "decision"]),
    ("Q11", "release management workflow branching", ["release", "branching"]),
    ("Q12", "Swiss compliance AI memory governance", ["compliance", "memory", "governance"]),
    ("Q13", "operations log March 2026 engineering", ["operations log", "engineering"]),
    ("Q14", "agent notion publisher", ["agent", "notion"]),
    ("Q15", "Azure cloud foundation product value brief", ["azure", "cloud foundation"]),
]

def query_v1(q: str) -> list[dict]:
    body = json.dumps({"query": q, "owner": "ardin", "scope": "all", "limit": 5}).encode()
    req = urllib.request.Request(f"{BASE}/v1/recall", data=body, headers={
        "Content-Type": "application/json", "x-api-key": API_KEY,
    })
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=15).read())
        return d.get("results", [])
    except Exception as e:
        print(f"  v1 error: {e}")
        return []

def query_v2(q: str) -> list[dict]:
    body = json.dumps({"query": q, "purpose": "personal-recall", "limit": 5}).encode()
    req = urllib.request.Request(f"{BASE}/v2/recall", data=body, headers={
        "Content-Type": "application/json", "x-api-key": API_KEY,
    })
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=15).read())
        return d.get("hits", [])
    except Exception as e:
        print(f"  v2 error: {e}")
        return []

def v1_alias(hit: dict) -> str:
    fm = hit.get("memory", {}).get("frontmatter", {})
    aliases = fm.get("aliases", [])
    return (aliases[0] if aliases else "").lower()

def v2_alias(hit: dict) -> str:
    # v2 stores alias in excerpt prefix (we set excerpt = "alias — first_line")
    excerpt = hit.get("excerpt", "")
    if " — " in excerpt:
        return excerpt.split(" — ")[0].lower()
    return excerpt.lower()

def is_relevant(alias: str, expected_kws: list[str]) -> bool:
    if not alias:
        return False
    return any(kw.lower() in alias for kw in expected_kws)

def main():
    print(f"Running {len(QUERIES)} queries on /v1/recall and /v2/recall...\n")
    v1_p1, v1_p5, v1_any5 = [], [], []
    v2_p1, v2_p5, v2_any5 = [], [], []
    rows = []
    for label, q, kws in QUERIES:
        v1_hits = query_v1(q)
        v2_hits = query_v2(q)

        v1_aliases = [v1_alias(h) for h in v1_hits]
        v2_aliases = [v2_alias(h) for h in v2_hits]

        v1_p1_v = 1 if v1_aliases and is_relevant(v1_aliases[0], kws) else 0
        v2_p1_v = 1 if v2_aliases and is_relevant(v2_aliases[0], kws) else 0
        v1_rel = [is_relevant(a, kws) for a in v1_aliases[:5]]
        v2_rel = [is_relevant(a, kws) for a in v2_aliases[:5]]
        v1_p5_v = sum(v1_rel) / max(len(v1_rel), 1)
        v2_p5_v = sum(v2_rel) / max(len(v2_rel), 1)
        v1_any5_v = 1 if any(v1_rel) else 0
        v2_any5_v = 1 if any(v2_rel) else 0

        v1_p1.append(v1_p1_v); v1_p5.append(v1_p5_v); v1_any5.append(v1_any5_v)
        v2_p1.append(v2_p1_v); v2_p5.append(v2_p5_v); v2_any5.append(v2_any5_v)

        rows.append({
            "label": label, "query": q,
            "v1_top1": v1_aliases[0] if v1_aliases else "—",
            "v2_top1": v2_aliases[0] if v2_aliases else "—",
            "v1_p1": v1_p1_v, "v2_p1": v2_p1_v,
            "v1_any5": v1_any5_v, "v2_any5": v2_any5_v,
        })

    print(f"{'Q':<5} {'P@1 v1→v2':<12} {'Any@5 v1→v2':<14} {'v2 top-1'}")
    print("-" * 95)
    for r in rows:
        d1 = f"{r['v1_p1']}→{r['v2_p1']}"
        d2 = f"{r['v1_any5']}→{r['v2_any5']}"
        print(f"{r['label']:<5} {d1:<12} {d2:<14} {r['v2_top1'][:60]}")

    print()
    print("=" * 80)
    print(f"{'Metric':<25} {'v1':>10} {'v2':>10} {'Δ':>10}")
    print("-" * 80)
    def line(name, v1, v2):
        m1, m2 = statistics.mean(v1), statistics.mean(v2)
        print(f"{name:<25} {m1:>10.3f} {m2:>10.3f} {(m2-m1):>+10.3f}")
    line("Precision@1", v1_p1, v2_p1)
    line("Precision@5 (avg)", v1_p5, v2_p5)
    line("Any-relevant@5", v1_any5, v2_any5)
    print("=" * 80)
    print(f"\nTotal queries: {len(QUERIES)}")
    print(f"v1 top-1 wins: {sum(v1_p1)}/{len(QUERIES)}")
    print(f"v2 top-1 wins: {sum(v2_p1)}/{len(QUERIES)}")

if __name__ == "__main__":
    main()
