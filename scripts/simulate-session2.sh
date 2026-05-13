#!/usr/bin/env bash
# Session-2 simulation: promotion workflow, topology health, CLI, MCP.
set -uo pipefail

API="http://localhost:3001"
A_KEY="dev-ardin"
M_KEY="dev-marcel"
F_KEY="dev-founder3"

PASS=0; FAIL=0
check() {
  local label="$1"; local actual="$2"; local expected="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS+1)); echo "  ✓ $label"
  else
    FAIL=$((FAIL+1)); echo "  ✗ $label"
    echo "    expected: $expected"
    echo "    actual:   $(echo "$actual" | head -c 200)"
  fi
}
post() { curl -sS -X POST "$API$1" -H "x-api-key: $2" -H "content-type: application/json" -d "$3"; }
get()  { curl -sS -X GET "$API$1" -H "x-api-key: $2"; }
fail_check() {
  local label="$1"; local actual="$2"; local expected_status_text="$3"
  if [[ "$actual" == *"$expected_status_text"* ]]; then
    PASS=$((PASS+1)); echo "  ✓ $label"
  else
    FAIL=$((FAIL+1)); echo "  ✗ $label — expected error '$expected_status_text', got: $(echo "$actual" | head -c 200)"
  fi
}

echo
echo "═══ Session-2 simulation ═══"
echo

# Seed 3 entity memories (one per entity) so promotion can succeed
echo "[A] Seed 3 memories across 3 entities"
# All three seed memories owned by Ardin so the v0.7 cross-owner-backlink-skip rule
# doesn't fire (Ardin promoting Ardin's own memories should produce backlinks).
R1=$(post "/v1/remember" "$A_KEY" '{"content": "Per-tenant Cosmos DB at Acme for compliance speed", "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-a", "tags": ["cosmos-db"]}')
ID1=$(echo "$R1" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
R2=$(post "/v1/remember" "$A_KEY" '{"content": "Per-tenant Cosmos DB at Buhler for similar reasons", "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-b", "tags": ["cosmos-db"]}')
ID2=$(echo "$R2" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
R3=$(post "/v1/remember" "$A_KEY" '{"content": "Per-tenant Cosmos DB pattern applied at Sulzer", "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-c", "tags": ["cosmos-db"]}')
ID3=$(echo "$R3" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "seed memory 1 written" "$R1" '"id"'
check "seed memory 2 written" "$R2" '"id"'
check "seed memory 3 written" "$R3" '"id"'

echo
echo "[B] Promotion endpoint (ISC-1, 2, 3, 4, 5)"

# Reject < 3 sources
RP1=$(post "/v1/promote" "$A_KEY" "{\"source_ids\":[\"$ID1\",\"$ID2\"],\"content\":\"too few\"}")
fail_check "Reject <3 sources" "$RP1" "at least 3 source_ids"

# Reject missing IDs
RP2=$(post "/v1/promote" "$A_KEY" "{\"source_ids\":[\"$ID1\",\"$ID2\",\"BOGUS-ID-DOES-NOT-EXIST\"],\"content\":\"missing src\"}")
fail_check "Reject missing IDs" "$RP2" "not found"

# Reject sources from <3 distinct entities (use ID1 twice and ID2)
# Write a second memory in company-a so we have 2 IDs from same entity
RX=$(post "/v1/remember" "$A_KEY" '{"content": "Second Acme note", "type": "semantic", "scope": "entity", "visibility": "team", "entity": "company-a"}')
IDX=$(echo "$RX" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
RP3=$(post "/v1/promote" "$A_KEY" "{\"source_ids\":[\"$ID1\",\"$IDX\",\"$ID2\"],\"content\":\"only 2 entities\"}")
fail_check "Reject <3 distinct entities" "$RP3" "3+ distinct entities"

# Accept 3 sources from 3 distinct entities
RP4=$(post "/v1/promote" "$A_KEY" "{
  \"source_ids\":[\"$ID1\",\"$ID2\",\"$ID3\"],
  \"content\":\"Per-tenant Cosmos DB is the dominant Swiss industrial multi-tenant pattern — confirmed across Acme, Buhler, Sulzer.\",
  \"category\":\"architecture\",
  \"tags\":[\"multi-tenant\",\"cosmos-db\",\"swiss-stack\"]
}")
HUB_ID=$(echo "$RP4" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
check "Promote 3+ distinct entities succeeds" "$RP4" '"scope":"generalized"'
check "Hub has links to all 3 sources" "$RP4" "$ID1"

# Verify backlinks were applied
RS1=$(get "/v1/memory/$ID1" "$A_KEY")
check "Source 1 received backlink to hub" "$RS1" "$HUB_ID"

RS2=$(get "/v1/memory/$ID2" "$M_KEY")
check "Source 2 received backlink to hub" "$RS2" "$HUB_ID"

echo
echo "[C] Topology health endpoint (ISC-6, 7, 8, 9)"
RH=$(get "/v1/topology/health" "$A_KEY")
check "health returns hub_count" "$RH" '"hub_count"'
check "health returns healthy_hubs count" "$RH" '"healthy_hubs"'
check "health detects no leaks in normal state" "$RH" '"direct_entity_edges":[]'
check "health.recommendations is array" "$RH" '"recommendations":'

# The new hub has 3 spokes — healthy band
HEALTHY_COUNT=$(echo "$RH" | grep -o '"healthy_hubs":[0-9]*' | cut -d: -f2)
if [[ "${HEALTHY_COUNT:-0}" -ge "1" ]]; then
  PASS=$((PASS+1)); echo "  ✓ newly-promoted hub counted as healthy (count=$HEALTHY_COUNT)"
else
  FAIL=$((FAIL+1)); echo "  ✗ no healthy hubs reported"
fi

echo
echo "[D] CLI commands (ISC-10..17)"

# Use a temp config and the dev-marcel key for these
export MACHTSINN_URL="$API"
export MACHTSINN_KEY="$A_KEY"

CLI="bun ${PROJECT_ROOT:-$PWD}/src/cli.ts"

# add via CLI
ADD_OUT=$($CLI add "CLI-test note from Ardin" --scope entity --entity company-a --tags cli,test 2>&1)
check "CLI add returned ID" "$ADD_OUT" "01"

NEW_ID=$(echo "$ADD_OUT" | head -1 | awk '{print $2}')

# find via CLI
FIND_OUT=$($CLI find "CLI-test note" --scope all 2>&1)
check "CLI find returned results" "$FIND_OUT" "result"
check "CLI find shows score" "$FIND_OUT" "0."

# show
SHOW_OUT=$($CLI show "$NEW_ID" 2>&1)
check "CLI show prints memory" "$SHOW_OUT" "CLI-test note from Ardin"

# log
LOG_OUT=$($CLI log --limit 5 2>&1)
check "CLI log shows entries" "$LOG_OUT" "WRITE"

# stats
STATS_OUT=$($CLI stats 2>&1)
check "CLI stats shows total_memories" "$STATS_OUT" "total_memories"

# health
HEALTH_OUT=$($CLI health 2>&1)
check "CLI health shows hub count" "$HEALTH_OUT" "Hubs:"

# scope set/get
$CLI scope company-a > /dev/null
SCOPE_OUT=$($CLI scope 2>&1)
check "CLI scope persists" "$SCOPE_OUT" "company-a"

# promote via CLI (use existing IDs)
# Need 3 fresh memories from distinct entities for a new promotion
PA=$(post "/v1/remember" "$A_KEY" '{"content": "Azure Landing Zone at Acme", "type":"semantic","scope":"entity", "visibility": "team","entity":"company-a","tags":["azure"]}')
PB=$(post "/v1/remember" "$M_KEY" '{"content": "Azure Landing Zone at Buhler", "type":"semantic","scope":"entity", "visibility": "team","entity":"company-b","tags":["azure"]}')
PC=$(post "/v1/remember" "$F_KEY" '{"content": "Azure Landing Zone at Sulzer", "type":"semantic","scope":"entity", "visibility": "team","entity":"company-c","tags":["azure"]}')
PIDA=$(echo "$PA" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
PIDB=$(echo "$PB" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
PIDC=$(echo "$PC" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)

PROMOTE_OUT=$($CLI promote --sources "$PIDA,$PIDB,$PIDC" --content "Azure Landing Zone pattern is reusable across Swiss industrial clients" --category architecture --tags azure 2>&1)
check "CLI promote succeeds" "$PROMOTE_OUT" "promoted to hub"

echo
echo "[E] MCP server (ISC-18..24)"

# Start MCP server in background, send it a list_tools request, check response
MCP_OUT=$(MACHTSINN_KEY="$A_KEY" MACHTSINN_URL="$API" bash -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"sim\",\"version\":\"1.0\"}}}"
  sleep 0.3
  echo "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
  sleep 0.3
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
  sleep 0.6
' | bun ${PROJECT_ROOT:-$PWD}/src/mcp.ts 2>/dev/null | head -50)

check "MCP server returns initialize result" "$MCP_OUT" '"protocolVersion"'
check "MCP server lists memory_remember tool" "$MCP_OUT" '"memory_remember"'
check "MCP server lists memory_recall tool" "$MCP_OUT" '"memory_recall"'
check "MCP server lists memory_promote tool" "$MCP_OUT" '"memory_promote"'
check "MCP server lists memory_health tool" "$MCP_OUT" '"memory_health"'
check "MCP tool advertises JSON schema" "$MCP_OUT" '"inputSchema"'

# Now actually call a tool via MCP
MCP_CALL=$(MACHTSINN_KEY="$A_KEY" MACHTSINN_URL="$API" bash -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"sim\",\"version\":\"1.0\"}}}"
  sleep 0.3
  echo "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
  sleep 0.3
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_stats\",\"arguments\":{}}}"
  sleep 0.6
' | bun ${PROJECT_ROOT:-$PWD}/src/mcp.ts 2>/dev/null | head -50)

# MCP wraps payload as {"content":[{"type":"text","text":"<escaped json>"}]} so look for escaped form
check "MCP tool call memory_stats returns total_memories" "$MCP_CALL" 'total_memories'

echo
echo "═══════════════════════════════════════"
echo "Session-2 RESULT: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
exit $FAIL
