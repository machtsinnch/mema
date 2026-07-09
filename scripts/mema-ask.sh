#!/usr/bin/env bash
# mema-ask.sh — ask your mema vault a question from the terminal.
#
#   ./scripts/mema-ask.sh "what jobs did I apply to?"
#   ./scripts/mema-ask.sh "leetcode plan" ardin-pai 12
#
# Args: 1=question (required), 2=owner (default ardin-pai), 3=limit (default 8)
# Server: http://localhost:3011 (override with MEMA_API)

set -euo pipefail
export Q="${1:?usage: mema-ask.sh \"question\" [owner] [limit]}"
export OWNER="${2:-ardin-pai}"
export LIMIT="${3:-8}"
export API="${MEMA_API:-http://localhost:3011}"

python3 <<'PYEOF'
import json, os, urllib.request

req = urllib.request.Request(
    os.environ["API"] + "/v2/recall",
    data=json.dumps({
        "query": os.environ["Q"],
        "purpose": "personal-test",
        "limit": int(os.environ["LIMIT"]),
    }).encode(),
    headers={
        "x-api-key": "dev-ardin",
        "x-owner": os.environ["OWNER"],
        "content-type": "application/json",
    },
)
d = json.load(urllib.request.urlopen(req, timeout=60))
hits = d.get("hits", [])
if not hits:
    print("no hits")
    raise SystemExit(0)
print(f'{len(hits)} hits (audit #{d.get("audit_id")})\n')
for i, h in enumerate(hits, 1):
    print(f'{i}. [{h["kind"]}] score {h["score"]:.3f} — {h.get("why_retrieved", "")}')
    p = h.get("payload") or {}
    if h["kind"] == "fact":
        vf = (p.get("valid_from") or "")[:10]
        print(f'   {p.get("subject")} —{p.get("predicate")}→ {p.get("object")}   (since {vf})')
    elif h["kind"] == "entity":
        print(f'   entity: {p.get("name")} ({p.get("entity_type")})')
    elif h["kind"] == "cognitive":
        print(f'   {(p.get("content") or "")[:160]}')
    else:
        print(f'   {(h.get("excerpt") or "")[:160]}')
    print()
PYEOF
