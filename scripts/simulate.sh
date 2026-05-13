#!/usr/bin/env bash
# Simulation: 3 founders × 3 companies, exercising every endpoint + every ISC.
# Usage: bash scripts/simulate.sh

set -uo pipefail
API="http://localhost:3001"

A_KEY="dev-ardin"
M_KEY="dev-marcel"
F_KEY="dev-founder3"

PASS=0
FAIL=0
SKIP_REPORT=()

check() {
  local label="$1"; local actual="$2"; local expected="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS+1))
    echo "  ✓ $label"
  else
    FAIL=$((FAIL+1))
    echo "  ✗ $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

post() {
  local key="$1"; local path="$2"; local body="$3"
  curl -sS -X POST "$API$path" \
    -H "x-api-key: $key" -H "content-type: application/json" \
    -d "$body"
}

get() {
  local key="$1"; local path="$2"
  curl -sS -X GET "$API$path" \
    -H "x-api-key: $key"
}

put() {
  local key="$1"; local path="$2"; local body="$3"
  curl -sS -X PUT "$API$path" \
    -H "x-api-key: $key" -H "content-type: application/json" \
    -d "$body"
}

echo
echo "═══ Simulation: 3 founders × 3 companies ═══"
echo

echo "[A] Health check (ISC-25 server starts)"
H=$(curl -sS "$API/health")
check "server healthy" "$H" '"ok":true'

echo
echo "[B] Ardin writes memories for company-a (ISC-26, 27, 28)"
R1=$(post "$A_KEY" /v1/remember '{
  "content": "Acme Corp engineering team uses Cosmos DB for tenant isolation. Lead architect Alice prefers per-tenant containers over shared with RLS for compliance speed.",
  "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-a",
  "tags": ["architecture", "cosmos-db", "multi-tenant"], "path": "project-1/research"
}')
ID_A1=$(echo "$R1" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Ardin wrote company-a memory 1" "$R1" '"owner":"ardin"'

R2=$(post "$A_KEY" /v1/remember '{
  "content": "ADR-001: Chose Cosmos DB per-tenant. Trade-off: +35% cost vs shared, but 2-3x faster audit cycles. Approved by Alice and team.",
  "type": "procedural", "scope": "entity", "visibility": "team", "entity": "company-a",
  "tags": ["adr", "architecture", "cosmos-db"], "path": "project-1/decisions"
}')
ID_A2=$(echo "$R2" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Ardin wrote company-a memory 2 (ADR)" "$R2" '"type":"procedural"'

echo
echo "[C] Marcel writes memories for company-b (multi-user, isolated)"
R3=$(post "$M_KEY" /v1/remember '{
  "content": "Bühler is also on SAP S/4HANA, planning Azure migration similar to Acme. Tier-2 supplier discovery call notes.",
  "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-b",
  "tags": ["sap", "azure", "swiss-stack"]
}')
ID_B1=$(echo "$R3" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Marcel wrote company-b memory" "$R3" '"owner":"marcel"'

R4=$(post "$M_KEY" /v1/remember '{
  "content": "ADR-007: Bühler chose per-tenant Cosmos DB after seeing the Acme pattern. Confirms the multi-tenant approach generalizes.",
  "type": "procedural", "scope": "entity", "visibility": "team", "entity": "company-b",
  "tags": ["adr", "cosmos-db", "multi-tenant"]
}')
check "Marcel wrote company-b ADR" "$R4" '"owner":"marcel"'

echo
echo "[D] Founder3 writes memory for company-c"
R5=$(post "$F_KEY" /v1/remember '{
  "content": "Sulzer interested in same SAP-on-Azure pattern. Early discovery. They use Cosmos DB elsewhere already.",
  "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-c",
  "tags": ["sap", "azure", "cosmos-db", "swiss-stack"]
}')
ID_C1=$(echo "$R5" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Founder3 wrote company-c memory" "$R5" '"owner":"founder3"'

echo
echo "[E] Pattern observed in 3+ entities → promote to generalized layer (the N=3 rule)"
R6=$(post "$A_KEY" /v1/remember "{
  \"content\": \"Multi-tenant pattern: per-tenant Cosmos DB beats shared-with-RLS on compliance audit speed for Swiss industrial SMEs. Confirmed in 3 engagements (Acme, Bühler, Sulzer).\",
  \"type\": \"semantic\", \"scope\": \"generalized\", \"category\": \"architecture\",
  \"tags\": [\"multi-tenant\", \"cosmos-db\", \"azure\", \"swiss-stack\"],
  \"visibility\": \"team\",
  \"links\": [\"$ID_A2\", \"$ID_B1\", \"$ID_C1\"]
}")
ID_G1=$(echo "$R6" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Generalized pattern promoted" "$R6" '"scope":"generalized"'

echo
echo "[F] Recall — Marcel asks about multi-tenant (ISC-6, ISC-19, ISC-21)"
RC1=$(post "$M_KEY" /v1/recall '{
  "query": "multi-tenant Cosmos pattern",
  "scope": "current",
  "entity": "company-b"
}')
check "Marcel sees company-b ADR (own entity)" "$RC1" "$ID_B1"
check "Marcel sees generalized pattern" "$RC1" "$ID_G1"
NOT_LEAK=$(echo "$RC1" | grep -c "$ID_A1" || true)
if [[ "$NOT_LEAK" == "0" ]]; then
  PASS=$((PASS+1)); echo "  ✓ Marcel does NOT see Ardin's company-a memory (isolation holds)"
else
  FAIL=$((FAIL+1)); echo "  ✗ company-a leaked into Marcel's company-b search!"
fi

echo
echo "[G] Cross-entity search with scope=all (ISC-19)"
RC2=$(post "$F_KEY" /v1/recall '{
  "query": "Cosmos DB",
  "scope": "all"
}')
check "Founder3 with scope=all sees company-a (Ardin's)" "$RC2" "$ID_A1"
check "Founder3 with scope=all sees company-b (Marcel's)" "$RC2" "$ID_B1"

echo
echo "[H] Personal private memory NOT leaked (ISC-18)"
R7=$(post "$A_KEY" /v1/remember '{
  "content": "I am thinking about leaving machtsinn next year — personal note.",
  "type": "semantic", "scope": "user", "visibility": "private",
  "tags": ["personal", "career"]
}')
ID_U1=$(echo "$R7" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Ardin wrote private user note" "$R7" '"visibility":"private"'

RC3=$(post "$M_KEY" /v1/recall '{
  "query": "leaving machtsinn personal",
  "scope": "all"
}')
LEAKED=$(echo "$RC3" | grep -c "$ID_U1" || true)
if [[ "$LEAKED" == "0" ]]; then
  PASS=$((PASS+1)); echo "  ✓ Ardin's private memory hidden from Marcel even with scope=all"
else
  FAIL=$((FAIL+1)); echo "  ✗ PRIVATE LEAK: Marcel saw Ardin's private memory!"
fi

echo
echo "[I] Update a memory (ISC-8)"
RU=$(put "$A_KEY" "/v1/memory/$ID_A1" '{
  "trust": 0.95,
  "tags": ["architecture", "cosmos-db", "multi-tenant", "verified"]
}')
check "Update returned new trust" "$RU" '"trust":0.95'
check "Update added tag" "$RU" '"verified"'

echo
echo "[J] Forget a memory (ISC-7, ISC-14, ISC-23)"
RF=$(post "$A_KEY" /v1/forget "{
  \"id\": \"$ID_A2\",
  \"actor\": \"ardin\",
  \"reason\": \"superseded by generalized pattern\"
}")
check "Forget returned forgotten=true" "$RF" '"forgotten":true'

RC4=$(post "$A_KEY" /v1/recall "{
  \"query\": \"ADR-001 Cosmos\",
  \"scope\": \"current\",
  \"entity\": \"company-a\"
}")
# Check that the forgotten memory's id does not appear as a result's frontmatter.id
# (it may still appear inside another memory's `links` array — that's expected).
GONE=$(echo "$RC4" | grep -c "\"id\":\"$ID_A2\"" || true)
# We allow 0 (not a result) OR exactly 1 occurrence ONLY if it's inside a links array.
# Simpler check: search results array's memory ids must not include ID_A2.
RESULT_IDS=$(echo "$RC4" | grep -o '"frontmatter":{"id":"[^"]*' | cut -d'"' -f6)
if ! echo "$RESULT_IDS" | grep -q "$ID_A2"; then
  PASS=$((PASS+1)); echo "  ✓ Forgotten memory excluded from recall results"
else
  FAIL=$((FAIL+1)); echo "  ✗ Forgotten memory still appearing as a result!"
fi

echo
echo "[K] Provenance log (ISC-10, ISC-22, ISC-24)"
LOG=$(get "$A_KEY" "/v1/log?limit=20")
check "Log contains WRITE ops" "$LOG" '"op":"WRITE"'
check "Log contains FORGET op" "$LOG" '"op":"FORGET"'
check "Log contains UPDATE op" "$LOG" '"op":"UPDATE"'
check "Log entries have timestamp" "$LOG" '"ts":"20'

echo
echo "[L] Topology stats (ISC-11, ISC-31)"
ST=$(get "$A_KEY" "/v1/stats")
check "Stats reports total_memories" "$ST" '"total_memories"'
check "Stats lists company-a" "$ST" '"company-a"'
check "Stats lists company-b" "$ST" '"company-b"'
check "Stats lists company-c" "$ST" '"company-c"'
check "Stats reports hubs" "$ST" '"hubs":'
check "Stats reports max_spokes" "$ST" '"max_spokes":'

echo
echo "[M] Get memory by ID (ISC-9)"
RG=$(get "$A_KEY" "/v1/memory/$ID_G1")
check "GET by id returns memory" "$RG" "$ID_G1"

echo
echo "[N] Filesystem inspection (ISC-3, ISC-4, ISC-32 Obsidian-compatible)"
if [[ -f "data/entities/company-a/project-1/research/$ID_A1.md" ]]; then
  PASS=$((PASS+1)); echo "  ✓ File written at hierarchical path entities/company-a/project-1/research/"
else
  FAIL=$((FAIL+1)); echo "  ✗ Expected hierarchical file not found"
fi

FRONT=$(head -20 "data/entities/company-a/project-1/research/$ID_A1.md" 2>/dev/null || echo "")
check "File has YAML frontmatter" "$FRONT" '---'
check "Frontmatter contains visibility" "$FRONT" 'visibility:'
check "Frontmatter contains scope" "$FRONT" 'scope:'

# Generalized memory
if [[ -f "data/generalized/architecture/$ID_G1.md" ]]; then
  PASS=$((PASS+1)); echo "  ✓ Generalized memory at generalized/architecture/"
else
  FAIL=$((FAIL+1)); echo "  ✗ Generalized memory not at expected path"
fi

# User-private memory
USER_FILES=$(find data/users/ardin -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$USER_FILES" -ge "1" ]]; then
  PASS=$((PASS+1)); echo "  ✓ User-private memory at users/ardin/ ($USER_FILES files)"
else
  FAIL=$((FAIL+1)); echo "  ✗ User-private memory missing"
fi

echo
echo "═══════════════════════════════════════"
echo "RESULT: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
exit $FAIL
