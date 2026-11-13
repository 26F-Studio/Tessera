#!/usr/bin/env bash
# Manual, operator-run backup of one Techmino online deployment.
#
# A backup is only consistent when the services are drained: database rows and
# replay files are captured in the same offline window. This tool
#   * refuses to write into an existing non-empty directory;
#   * refuses to run while either database still has client connections;
#   * requires --confirm-drained as an explicit operator acknowledgement.
#
# Role definitions, passwords and cluster globals are deliberately not part of a
# backup. The destination deployment creates its own roles, and restore.sh
# re-establishes the runtime grants.
#
# Usage:
#   backup.sh --out-dir DIR [--env-dir DIR] [--replay-dir DIR] [--label TEXT]
#             [--confirm-drained]
#
# Dump both databases plus the replay archive:
#   docker compose -f deploy/compose.yml stop tessera cadence website
#   docker compose -f deploy/compose.yml --profile tools run --rm tools \
#     backup --out-dir /backup/2026-10-07T120000Z --confirm-drained

set -euo pipefail
usage() { sed -n '2,20p' "$0"; }

. "$(dirname "$0")/common.sh"

out_dir=''
env_dir=${ENV_DIR:-/deploy/runtime}
replay_dir=${REPLAY_DIR:-/replays}
label=${LABEL:-}
confirmed=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir=${2:?--out-dir requires a directory}; shift 2 ;;
    --env-dir) env_dir=${2:?--env-dir requires a directory}; shift 2 ;;
    --replay-dir) replay_dir=${2:?--replay-dir requires a directory}; shift 2 ;;
    --label) label=${2:?--label requires a value}; shift 2 ;;
    --confirm-drained) confirmed=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$out_dir" ] || { usage >&2; die '--out-dir is required'; }
[ "$confirmed" = "1" ] || die 'refusing to back up a live deployment: drain the services, then pass --confirm-drained'
require_pg_tools
umask 077

if [ -e "$out_dir" ] && [ -n "$(ls -A "$out_dir" 2>/dev/null)" ]; then
  die "refusing to overwrite existing backup directory: $out_dir"
fi
mkdir -p "$out_dir"
chmod 700 "$out_dir"

tessera_env="$env_dir/tessera.env"
cadence_env="$env_dir/cadence.env"
tessera_url=$(env_value "$tessera_env" MIGRATION_DATABASE_URL)
cadence_url=$(env_value "$cadence_env" MIGRATION_DATABASE_URL)
[ -d "$replay_dir" ] || die "replay directory not found: $replay_dir"

note 'Checking that the deployment is actually drained...'
require_no_clients "$tessera_url" 'the Tessera database'
require_no_clients "$cadence_url" 'the Cadence database'

tessera_database=$(parse_connection_url "$tessera_url" >/dev/null; printf '%s' "$URL_DATABASE")
cadence_database=$(parse_connection_url "$cadence_url" >/dev/null; printf '%s' "$URL_DATABASE")

note "Dumping $tessera_database..."
parse_connection_url "$tessera_url"
PGPASSWORD="$URL_PASSWORD" "$(tool_path pg_dump)" \
  --format=custom --compress=6 \
  --file "$out_dir/tessera.dump" --dbname "$(url_without_password "$tessera_url")"

note "Dumping $cadence_database..."
parse_connection_url "$cadence_url"
PGPASSWORD="$URL_PASSWORD" "$(tool_path pg_dump)" \
  --format=custom --compress=6 \
  --file "$out_dir/cadence.dump" --dbname "$(url_without_password "$cadence_url")"

note 'Copying replay files...'
mkdir -p "$out_dir/replays"
cp -a "$replay_dir/." "$out_dir/replays/"

for file in "$out_dir/tessera.dump" "$out_dir/cadence.dump"; do
  [ -s "$file" ] || die "dump is missing or empty: $file"
done

tessera_bytes=$(wc -c <"$out_dir/tessera.dump")
cadence_bytes=$(wc -c <"$out_dir/cadence.dump")
replay_count=$(find "$out_dir/replays" -type f | wc -l)
replay_kib=$(du -sk "$out_dir/replays" | cut -f1)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pg_dump_version=$("$(tool_path pg_dump)" --version)

{
  printf '{\n'
  printf '  "tool": "techmino-deploy-backup",\n'
  printf '  "formatVersion": 1,\n'
  printf '  "createdAt": %s,\n' "$(json_string "$created_at")"
  printf '  "label": %s,\n' "$(json_string "$label")"
  printf '  "drainConfirmed": true,\n'
  printf '  "pgDumpVersion": %s,\n' "$(json_string "$pg_dump_version")"
  printf '  "databases": [\n'
  printf '    {"product": "tessera", "database": %s, "file": "tessera.dump", "bytes": %s},\n' "$(json_string "$tessera_database")" "$tessera_bytes"
  printf '    {"product": "cadence", "database": %s, "file": "cadence.dump", "bytes": %s}\n' "$(json_string "$cadence_database")" "$cadence_bytes"
  printf '  ],\n'
  printf '  "replays": {"fileCount": %s, "kibibytes": %s},\n' "$replay_count" "$replay_kib"
  printf '  "notes": ["Role definitions and passwords are intentionally excluded.", "Restore into isolated databases with deploy/tools/restore.sh."]\n'
  printf '}\n'
} >"$out_dir/manifest.json"

chmod 600 "$out_dir/manifest.json" "$out_dir/tessera.dump" "$out_dir/cadence.dump"
chmod 700 "$out_dir/replays"

note "Backup complete: $out_dir"
note "  tessera.dump: $tessera_bytes bytes ($tessera_database)"
note "  cadence.dump: $cadence_bytes bytes ($cadence_database)"
note "  replays: $replay_count file(s), ${replay_kib} KiB"
note 'Keep this directory offline and readable only by the operator.'
