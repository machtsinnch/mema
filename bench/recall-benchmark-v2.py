#!/usr/bin/env python3
"""
Expanded recall benchmark (v2): 25 queries, three configurations.

  - v1:           /v1/recall (legacy hybrid scoring)
  - v2-keyword:   /v2/recall with use_vector=false (BM25 IDF + title boost)
  - v2-fused:     /v2/recall with use_vector=true (BM25 + title + vector cosine)

Metrics:
  - Precision@1: top-1 alias matches an expected keyword
  - Precision@5 (avg): fraction of top-5 hits with matching alias
  - Any-relevant@5: at least one hit in top-5 is relevant
  - Avg score on top-1 (sanity check)

Expected keywords are deliberately specific to the canonical correct doc.
"""
import json, urllib.request, statistics, sys

API_KEY = "dev-ardin"
BASE = "http://localhost:3001"

QUERIES = [
    # (label, query, expected_keywords_in_alias_or_title)
    ("Q01", "Säule 3a Pillar 3a strategy", ["pillar 3a", "säule 3a", "swiss tax"]),
    ("Q02", "concentration position sizing strategy", ["concentration", "position sizing"]),
    ("Q03", "antifragile portfolio bear markets", ["antifragile", "anti-fragile", "bear market"]),
    ("Q04", "megatrend artificial intelligence aging population", ["megatrend"]),
    ("Q05", "pricing page positioning value communication", ["pricing", "positioning"]),
    ("Q06", "competitive positioning analysis", ["competitive", "positioning"]),
    ("Q07", "elevator pitch value proposition", ["pitch", "value", "positioning", "wedge"]),
    ("Q08", "US go-to-market strategy", ["go-to-market", "us ", "gtm"]),
    ("Q09", "deployment model impact assessment", ["deployment", "impact"]),
    ("Q10", "founder decision pack", ["founder", "decision"]),
    ("Q11", "release management workflow branching", ["release", "branching"]),
    ("Q12", "Swiss compliance AI memory governance", ["compliance", "memory", "governance", "finma", "wedge"]),
    ("Q13", "operations log March 2026 engineering", ["operations log", "engineering"]),
    ("Q14", "agent notion publisher", ["agent", "notion"]),
    ("Q15", "Azure cloud foundation product value brief", ["azure", "cloud foundation"]),
    # Paraphrase-heavy queries (vector should help more here)
    ("Q16", "elite investment plan top one percent portfolio", ["1%", "elite", "master plan"]),
    ("Q17", "research portfolio analysis ruthless critique", ["critique", "portfolio"]),
    ("Q18", "FINMA Swiss financial regulation AI compliance gap", ["finma", "compliance"]),
    ("Q19", "marketplace partner distribution strategy", ["marketplace", "partner"]),
    ("Q20", "Cosmos DB multi-tenant data isolation Azure", ["cosmos", "multi-tenant"]),
    ("Q21", "round 4 tier differentiation pricing", ["round 4", "tier", "differentiation"]),
    ("Q22", "round 5 deployment model marketing invisible", ["round 5", "deployment", "marketing"]),
    ("Q23", "willingness to pay partner pricing", ["partner", "pricing", "willingness"]),
    ("Q24", "Buhler Azure landing zone deployment", ["azure", "landing zone", "buhler"]),
    ("Q25", "Customer A admin portal CRUD backend", ["admin", "portal", "crud"]),
]

def call(endpoint, body):
    req = urllib.request.Request(
        f"{BASE}{endpoint}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
    )
    return json.loads(urllib.request.urlopen(req, timeout=20).read())

def v1_hits(q):
    return call("/v1/recall", {"query": q, "owner": "ardin", "scope": "all", "limit": 5}).get("results", [])

def v2_hits(q, use_vector=True):
    # owner is resolved server-side from the API key (dev-ardin → owner=ardin),
    # but pass it explicitly here so anyone reading the benchmark sees the
    # multi-tenant boundary is engaged.
    return call("/v2/recall", {
        "query": q,
        "owner": "ardin",
        "purpose": "personal-recall",
        "limit": 5,
        "use_vector": use_vector,
    }).get("hits", [])

def v1_alias(h):
    fm = h.get("memory", {}).get("frontmatter", {})
    return (fm.get("aliases", [""])[0] if fm.get("aliases") else "").lower()

def v2_alias(h):
    e = h.get("excerpt", "")
    return (e.split(" — ")[0] if " — " in e else e).lower()

def relevant(alias, kws):
    return any(kw in alias for kw in kws) if alias else False

def score(label, hits_fn, kws_for_query):
    p1s, p5s, any5s, score_top1s = [], [], [], []
    rows = []
    for label_q, q, kws in QUERIES:
        try: hits = hits_fn(q)
        except Exception as e:
            print(f"  {label_q} error: {e}", file=sys.stderr); hits = []
        # v1 hits have a 'memory' wrapper, v2 hits have 'excerpt' directly
        aliases = [v1_alias(h) if "memory" in h else v2_alias(h) for h in hits]
        rel = [relevant(a, kws) for a in aliases[:5]]
        p1 = 1 if rel and rel[0] else 0
        p5 = sum(rel) / max(len(rel), 1)
        any5 = 1 if any(rel) else 0
        s = hits[0].get("score", 0) if hits else 0
        p1s.append(p1); p5s.append(p5); any5s.append(any5); score_top1s.append(s)
        rows.append((label_q, q[:30], aliases[0][:50] if aliases else "—", p1, any5, s))
    return p1s, p5s, any5s, score_top1s, rows

print(f"Running {len(QUERIES)} queries × 3 configs...\n")

v1_p1, v1_p5, v1_any5, v1_scores, v1_rows = score("v1", v1_hits, None)
v2k_p1, v2k_p5, v2k_any5, v2k_scores, v2k_rows = score("v2-keyword", lambda q: v2_hits(q, False), None)
v2f_p1, v2f_p5, v2f_any5, v2f_scores, v2f_rows = score("v2-fused", lambda q: v2_hits(q, True), None)

print(f"{'Q':<5} {'P@1':<12} {'v2-fused top-1'}")
print("-" * 95)
for i in range(len(QUERIES)):
    label = QUERIES[i][0]
    d = f"{v1_p1[i]}→{v2k_p1[i]}→{v2f_p1[i]}"
    print(f"{label:<5} {d:<12} {v2f_rows[i][2]}")

print("\n" + "=" * 80)
print(f"{'Metric':<25} {'v1':>10} {'v2-keyword':>13} {'v2-fused':>11}")
print("-" * 80)
def line(name, a, b, c):
    print(f"{name:<25} {statistics.mean(a):>10.3f} {statistics.mean(b):>13.3f} {statistics.mean(c):>11.3f}")
line("Precision@1", v1_p1, v2k_p1, v2f_p1)
line("Precision@5 (avg)", v1_p5, v2k_p5, v2f_p5)
line("Any-relevant@5", v1_any5, v2k_any5, v2f_any5)
print("=" * 80)
print(f"\nTop-1 wins: v1={sum(v1_p1)}/{len(QUERIES)}  v2-keyword={sum(v2k_p1)}/{len(QUERIES)}  v2-fused={sum(v2f_p1)}/{len(QUERIES)}")
print(f"Δ v2-fused over v1: +{(statistics.mean(v2f_p1) - statistics.mean(v1_p1))*100:.1f}pp on Precision@1")
print(f"Δ v2-fused over v2-keyword: +{(statistics.mean(v2f_p1) - statistics.mean(v2k_p1))*100:.1f}pp on Precision@1")
