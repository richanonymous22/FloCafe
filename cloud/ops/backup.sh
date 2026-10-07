#!/usr/bin/env bash
# Plemmo Cloud — database backup.
#
#   PLEMMO_CLOUD_DB_URL=postgres://… ./backup.sh [output-dir]
#
# Writes <dir>/plemmo-cloud-<UTC timestamp>.dump (pg_dump custom format) and a manifest next to it with the
# schema version and a row count for every table, so a restore can later be CHECKED against what was backed up.
# Verifies the dump is readable. Optional: BACKUP_UPLOAD_CMD (run with the dump path as $1, e.g. an rclone or
# aws s3 cp wrapper) copies it off the machine; BACKUP_RETAIN_DAYS (default 14) prunes older local dumps.
# The database URL is read from the environment only and is never written to the manifest or the logs.
set -euo pipefail
: "${PLEMMO_CLOUD_DB_URL:?set PLEMMO_CLOUD_DB_URL}"
DIR="${1:-./backups}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/plemmo-cloud-$STAMP.dump"

pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$PLEMMO_CLOUD_DB_URL"
pg_restore --list "$OUT" > /dev/null   # fails if the dump is unreadable

SQL_VERSION="SELECT COALESCE(MAX(version),0) FROM cloud_schema_version"
VERSION="$(psql "$PLEMMO_CLOUD_DB_URL" -Atc "$SQL_VERSION")"
TABLES="$(psql "$PLEMMO_CLOUD_DB_URL" -Atc "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")"
{
  echo "{"
  echo "  \"created_at\": \"$STAMP\","
  echo "  \"schema_version\": $VERSION,"
  echo "  \"sha256\": \"$(sha256sum "$OUT" | cut -d' ' -f1)\","
  echo "  \"counts\": {"
  first=1
  for t in $TABLES; do
    n="$(psql "$PLEMMO_CLOUD_DB_URL" -Atc "SELECT COUNT(*) FROM \"$t\"")"
    [ $first -eq 1 ] || echo ","
    printf '    "%s": %s' "$t" "$n"
    first=0
  done
  echo ""
  echo "  }"
  echo "}"
} > "$OUT.manifest.json"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  $BACKUP_UPLOAD_CMD "$OUT" && $BACKUP_UPLOAD_CMD "$OUT.manifest.json"
fi
find "$DIR" -name 'plemmo-cloud-*.dump*' -mtime +"${BACKUP_RETAIN_DAYS:-14}" -delete
echo "$OUT"
