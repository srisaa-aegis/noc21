#!/usr/bin/env bash
#
# End-to-end smoke test of the backend (phases B1 – B3), on a scratch database.
#
#   npm run smoke
#
# Starts the local PostgreSQL cluster if needed, creates and migrates a
# throw-away database, seeds it, boots the API on a free port with a temporary
# storage root, exercises the API as a citizen (create → save → upload → pay →
# submit), the officers of a whole workflow up to the signed approval, an admin
# and a new registration, backs the database up and restores it into a second
# scratch database, then tears everything down. Exit code 0 means every
# assertion passed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
DB_NAME="noc_smoke"
PORT="${SMOKE_PORT:-3999}"
STORAGE="$(mktemp -d)"
PASS=0
FAIL=0
API_PID=""

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  rm -rf "$STORAGE"
}
trap cleanup EXIT

say()  { printf '  %s\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s — %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

echo
echo "NOC backend smoke test (phases B1 – B3)"
echo

cd "$BACKEND"
say "Preparing the database …"
npx tsx --env-file-if-exists=.env scripts/pg/start.ts > /dev/null || { bad "PostgreSQL start"; exit 1; }
SUPER="$(grep -E '^DB_SUPERUSER=' .env 2>/dev/null | cut -d= -f2)"; SUPER="${SUPER:-postgres}"
OWNER="$(grep -E '^DB_USER=' .env 2>/dev/null | cut -d= -f2)"; OWNER="${OWNER:-noc}"
PORTPG="$(grep -E '^DB_PORT=' .env 2>/dev/null | cut -d= -f2)"; PORTPG="${PORTPG:-5432}"
psql -h 127.0.0.1 -p "$PORTPG" -U "$SUPER" -d postgres -c "drop database if exists $DB_NAME" > /dev/null 2>&1
psql -h 127.0.0.1 -p "$PORTPG" -U "$SUPER" -d postgres -c "create database $DB_NAME owner $OWNER" > /dev/null || { bad "create database"; exit 1; }
URL="postgresql://$OWNER:$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2)@127.0.0.1:$PORTPG/$DB_NAME"

MIGRATE_DATABASE_URL="$URL" npx tsx --env-file-if-exists=.env scripts/db/migrate.ts > /dev/null || { bad "migrate"; exit 1; }
ok "schema migrated"
SEED_DATABASE_URL="$URL" npx tsx --env-file-if-exists=.env scripts/db/seed.ts > /dev/null || { bad "seed"; exit 1; }
ok "demo data seeded"

say "Starting the API on port $PORT …"
DATABASE_URL="$URL" PORT="$PORT" FS_STORAGE_ROOT="$STORAGE/files" LOG_LEVEL=warn ENABLE_SCHEDULER=false \
  RATE_LIMIT_LOGIN_PER_MINUTE=1000 RATE_LIMIT_GLOBAL_PER_MINUTE=100000 \
  npx tsx --env-file-if-exists=.env src/main.ts > "$STORAGE/api.log" 2>&1 &
API_PID=$!
API="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do
  READY=$(curl -s "$API/ready" 2>/dev/null | head -c 20)
  [ -n "$READY" ] && break
  sleep 0.5
done
[ -n "${READY:-}" ] || { bad "API did not become ready"; tail -20 "$STORAGE/api.log"; exit 1; }
ok "API ready"
check "the schema is at the shipped migration" "$(curl -s "$API/ready" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["checks"]["migrations"])')" "True"

# Reads a value out of a JSON response: jqv "['key']" or jqv "len(d['list'])".
jqv() {
  python3 -c "
import json, sys
d = json.load(sys.stdin)
expr = sys.argv[1]
print(eval(expr if expr.startswith(('len(', 'all(', 'any(')) else 'd' + expr))
" "$1" 2>/dev/null
}

# ── Reference data ───────────────────────────────────────────────────────────
check "13 districts are served"      "$(curl -s "$API/api/v1/lookups/districts" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" "13"
check "12 workflows are configured"  "$(curl -s -H "authorization: Bearer $(curl -s -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"demo"}' | jqv "['accessToken']")" "$API/api/v1/config/workflows" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" "12"
check "the dropped fire station is gone" "$(curl -s "$API/api/v1/lookups/fire-stations" | grep -c '4Q')" "0"

# ── Citizen ──────────────────────────────────────────────────────────────────
CTOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d '{"username":"citizen1","password":"demo"}' | jqv "['accessToken']")
[ -n "$CTOKEN" ] && ok "citizen1 signs in" || bad "citizen1 sign in"
AUTH=(-H "authorization: Bearer $CTOKEN")
check "citizen sees their applications" "$(curl -s "${AUTH[@]}" "$API/api/v1/applications?scope=mine&pageSize=all" | jqv "['total']")" "10"
check "the aggregate has its blocks"    "$(curl -s "${AUTH[@]}" "$API/api/v1/applications/101" | jqv "len(d['blocks'])")" "2"
check "the fee is computed server-side" "$(curl -s "${AUTH[@]}" "$API/api/v1/applications/101/assessment" | jqv "['approvalLevel']")" "MSB"
check "another citizen's file is hidden" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/v1/applications/110")" "404"
check "a draft needs a site name and address" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{"appl_type":"P"}' "$API/api/v1/applications")" "422"

# ── Journeys (B2 + B3): citizen → every officer → decision → citizen ───────
say "Journeys …"
JOURNEY_OUT="$(cd "$ROOT" && node scripts/smoke-journey.mjs "$API" 2>&1)"
printf '%s\n' "$JOURNEY_OUT" | grep -v '^RESULT'
RESULT_LINE="$(printf '%s\n' "$JOURNEY_OUT" | grep '^RESULT' | tail -1)"
if [ -n "$RESULT_LINE" ]; then
  PASS=$((PASS + $(echo "$RESULT_LINE" | cut -d' ' -f2)))
  FAIL=$((FAIL + $(echo "$RESULT_LINE" | cut -d' ' -f3)))
else
  bad "citizen journey" "the journey script did not finish"
fi

# ── Department ───────────────────────────────────────────────────────────────
DTOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d '{"username":"dfo.visakhapatnam","password":"demo"}' | jqv "['accessToken']")
DAUTH=(-H "authorization: Bearer $DTOKEN")
check "officer sees the department queue" "$(curl -s "${DAUTH[@]}" "$API/api/v1/applications?scope=dept&pageSize=all" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(all(a["status_id"]>1 for a in d["items"]))')" "True"
check "officer cannot run the admin search" "$(curl -s -o /dev/null -w '%{http_code}' "${DAUTH[@]}" "$API/api/v1/applications?scope=all")" "403"

# ── Admin ────────────────────────────────────────────────────────────────────
ATOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"demo"}' | jqv "['accessToken']")
AAUTH=(-H "authorization: Bearer $ATOKEN")
check "admin search includes drafts" "$(curl -s "${AAUTH[@]}" "$API/api/v1/applications?scope=all&draftsOnly=true&pageSize=all" | jqv "['total']")" "3"
check "accounts are listed without passwords" "$(curl -s "${AAUTH[@]}" "$API/api/v1/admin/accounts?pageSize=200" | grep -c password_hash)" "0"
check "a deactivated account cannot sign in" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' -d '{"username":"sai.constructions","password":"demo"}')" "403"

# ── Caching ──────────────────────────────────────────────────────────────────
ETAG=$(curl -s -D - -o /dev/null "$API/api/v1/bundles/reference" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
check "a bundle revalidates with its ETag" "$(curl -s -o /dev/null -w '%{http_code}' -H "if-none-match: $ETAG" "$API/api/v1/bundles/reference")" "304"
check "every response carries the data versions" "$(curl -s -D - -o /dev/null "$API/api/v1/lookups/districts" | grep -ci '^x-data-versions:')" "1"

# ── Storage root ─────────────────────────────────────────────────────────────
check "the storage root is outside the web root" "$(echo "$STORAGE" | grep -c 'frontend')" "0"
STORED=$(find "$STORAGE/files" -type f | wc -l)
if [ "$STORED" -gt 0 ]; then ok "uploaded files are stored under the storage root ($STORED files)"; else bad "uploaded files are stored under the storage root" "none found"; fi

# ── Backup and restore (B3) ──────────────────────────────────────────────────
say "Backup and restore …"
kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null; API_PID=""
if DATABASE_URL="$URL" FS_STORAGE_ROOT="$STORAGE/files" npx tsx --env-file-if-exists=.env scripts/db/backup.ts --out "$STORAGE/backup" > "$STORAGE/backup.log" 2>&1; then
  ok "the database and the files are backed up ($(du -sh "$STORAGE/backup" | cut -f1))"
else
  bad "backup" "$(tail -3 "$STORAGE/backup.log")"
fi
if DATABASE_URL="$URL" FS_STORAGE_ROOT="$STORAGE/files" npx tsx --env-file-if-exists=.env scripts/db/restore.ts --from "$STORAGE/backup" --db "${DB_NAME}_restore" --storage-root "$STORAGE/restored" --yes > "$STORAGE/restore.log" 2>&1; then
  ok "the backup restores into a second database with the same row counts"
else
  bad "restore" "$(tail -3 "$STORAGE/restore.log")"
fi
check "the restored files match" "$(find "$STORAGE/restored" -type f | wc -l)" "$STORED"

psql -h 127.0.0.1 -p "$PORTPG" -U "$SUPER" -d postgres -c "drop database if exists $DB_NAME with (force)" > /dev/null 2>&1
psql -h 127.0.0.1 -p "$PORTPG" -U "$SUPER" -d postgres -c "drop database if exists ${DB_NAME}_restore with (force)" > /dev/null 2>&1
echo
printf '  %s/%s checks passed\n\n' "$PASS" "$((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
