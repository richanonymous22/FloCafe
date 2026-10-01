#!/usr/bin/env bash
# Plemmo Cloud — restore rehearsal.
#
#   RESTORE_ADMIN_URL=postgres://…/postgres ./restore-rehearsal.sh <backup.dump>
#
# Restores a backup into a throwaway database and CHECKS it against the manifest written by backup.sh: the
# dump's checksum, the schema version, and the row count of every table. Exits non-zero on any difference, so it
# can run on a schedule. The scratch database is always dropped. RESTORE_ADMIN_URL must be able to CREATE and
# DROP DATABASE (never point it at the production database name). Run this against a recent production backup
# at least monthly, and after every change to the backup procedure.
set -euo pipefail
DUMP="${1:?usage: restore-rehearsal.sh <backup.dump>}"
: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL (a role that can create databases)}"
MANIFEST="$DUMP.manifest.json"
[ -f "$MANIFEST" ] || { echo "missing manifest $MANIFEST" >&2; exit 2; }

SCRATCH="plemmo_restore_check_$$"
# Same server and credentials as the admin URL, different database name (the query string is preserved).
SCRATCH_URL="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/$SCRATCH\1#")"
cleanup() { psql "$RESTORE_ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$SCRATCH\"" > /dev/null 2>&1 || true; }
trap cleanup EXIT

ACTUAL_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
WANT_SHA="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['sha256'])" "$MANIFEST")"
[ "$ACTUAL_SHA" = "$WANT_SHA" ] || { echo "FAIL: the backup file does not match its checksum (damaged or altered)" >&2; exit 1; }

psql "$RESTORE_ADMIN_URL" -qc "CREATE DATABASE \"$SCRATCH\""
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_URL" "$DUMP"

python3 - "$MANIFEST" "$SCRATCH_URL" <<'PY'
import json, subprocess, sys
manifest = json.load(open(sys.argv[1])); url = sys.argv[2]
def q(sql):
    return subprocess.check_output(['psql', url, '-Atc', sql], text=True).strip()
problems = []
version = int(q("SELECT COALESCE(MAX(version),0) FROM cloud_schema_version"))
if version != manifest['schema_version']:
    problems.append(f"schema version {version}, backup says {manifest['schema_version']}")
for table, want in manifest['counts'].items():
    got = int(q(f'SELECT COUNT(*) FROM "{table}"'))
    if got != want:
        problems.append(f"{table}: restored {got} rows, backup had {want}")
if problems:
    print("FAIL: restore does not match the backup:\n  " + "\n  ".join(problems), file=sys.stderr); sys.exit(1)
print(f"OK: restored schema v{version} and {len(manifest['counts'])} tables match the backup")
PY
