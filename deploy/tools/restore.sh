#!/usr/bin/env bash
# Restore a deployment backup into isolated new databases.
#
# The tool never touches the source databases and never overwrites an existing
# database: it creates fresh databases with a timestamped suffix in the
# destination deployment, restores into them, re-establishes the runtime grants,
# copies the replay archive next to the restored environment files, verifies the
# runtime roles and privileges, and writes protected environment files that point
# at the restored databases.
#
# Roles are created by the destination deployment's own initialization, so a
# backup is restored as the destination migration role with --no-owner --no-acl
# and then re-granted explicitly. Cluster globals and role passwords are never
# carried across deployments.
#
# Usage:
#   restore.sh --backup-dir DIR --dest-dir DIR --tessera-env FILE --cadence-env FILE
#              --admin-url-file FILE [--suffix NAME] [--replay-out DIR]
#              [--replay-container-dir PATH] [--cadence-grant-sql FILE] [--dry-run]
#
#   docker compose -f deploy/compose.yml --profile tools run --rm tools \
#     restore --backup-dir /backup/2026-10-07T120000Z --dest-dir /restored/2026-10-07 \
#     --tessera-env /deploy/runtime/tessera.env --cadence-env /deploy/runtime/cadence.env \
#     --admin-url-file /deploy/runtime/postgres-admin.url

set -euo pipefail

usage() { sed -n '2,27p' "$0"; }
. "$(dirname "$0")/common.sh"

backup_dir=''
dest_dir=''
tessera_env=''
cadence_env=''
admin_url_file=''
grant_sql=${CADENCE_GRANT_SQL:-/deploy/cadence-sql/grant-application.sql}
suffix=''
replay_out=''
replay_container_dir=${REPLAY_CONTAINER_DIR:-/replays-restored}
dry_run=0
tessera_group=tessera_application
cadence_group=cadence_application

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir) backup_dir=${2:?--backup-dir requires a directory}; shift 2 ;;
    --dest-dir) dest_dir=${2:?--dest-dir requires a directory}; shift 2 ;;
    --tessera-env) tessera_env=${2:?--tessera-env requires a file}; shift 2 ;;
    --cadence-env) cadence_env=${2:?--cadence-env requires a file}; shift 2 ;;
    --admin-url-file) admin_url_file=${2:?--admin-url-file requires a file}; shift 2 ;;
    --cadence-grant-sql) grant_sql=${2:?--cadence-grant-sql requires a file}; shift 2 ;;
    --suffix) suffix=${2:?--suffix requires a value}; shift 2 ;;
    --replay-out) replay_out=${2:?--replay-out requires a directory}; shift 2 ;;
    --replay-container-dir) replay_container_dir=${2:?--replay-container-dir requires a path}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$backup_dir" ] || { usage >&2; die '--backup-dir is required'; }
[ -n "$dest_dir" ] || { usage >&2; die '--dest-dir is required'; }
[ -n "$tessera_env" ] || { usage >&2; die '--tessera-env is required'; }
[ -n "$cadence_env" ] || { usage >&2; die '--cadence-env is required'; }
[ -n "$admin_url_file" ] || { usage >&2; die '--admin-url-file is required'; }

require_pg_tools
umask 077

[ -f "$backup_dir/manifest.json" ] || die "no backup manifest in $backup_dir"
[ -f "$backup_dir/tessera.dump" ] || die "missing $backup_dir/tessera.dump"
[ -f "$backup_dir/cadence.dump" ] || die "missing $backup_dir/cadence.dump"
[ -f "$grant_sql" ] || die "Cadence grant SQL not found: $grant_sql"
if [ -e "$dest_dir" ] && [ -n "$(ls -A "$dest_dir" 2>/dev/null)" ]; then
  die "refusing to write into a non-empty destination directory: $dest_dir"
fi

[ -z "$suffix" ] && suffix=$(date -u +%Y%m%dt%H%M%Sz)
case "$suffix" in
  *[!a-z0-9_]*) die 'the suffix may only contain lowercase letters, digits and underscores' ;;
esac

tessera_migration_url=$(env_value "$tessera_env" MIGRATION_DATABASE_URL)
tessera_runtime_url=$(env_value "$tessera_env" DATABASE_URL)
cadence_migration_url=$(env_value "$cadence_env" MIGRATION_DATABASE_URL)
cadence_runtime_url=$(env_value "$cadence_env" DATABASE_URL)
admin_url=$(read_admin_url "$admin_url_file")

parse_connection_url "$tessera_migration_url"
tessera_migrator=$URL_USER
tessera_source_database=$URL_DATABASE
parse_connection_url "$tessera_runtime_url"
tessera_app=$URL_USER
parse_connection_url "$cadence_migration_url"
cadence_migrator=$URL_USER
cadence_source_database=$URL_DATABASE
parse_connection_url "$cadence_runtime_url"
cadence_app=$URL_USER

for role in "$tessera_migrator" "$tessera_app" "$cadence_migrator" "$cadence_app"; do
  case "$role" in
    ''|*[!a-z0-9_]*) die 'destination environment files contain an unexpected role name' ;;
  esac
done

tessera_restore_database="${tessera_source_database}_restore_${suffix}"
cadence_restore_database="${cadence_source_database}_restore_${suffix}"
[ "${#tessera_restore_database}" -le 63 ] || die 'restored database name exceeds 63 characters'
[ "${#cadence_restore_database}" -le 63 ] || die 'restored database name exceeds 63 characters'
[ -n "$replay_out" ] || replay_out="$dest_dir/replays"

admin_superuser=$(psql_scalar "$admin_url" "SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user")
[ "$admin_superuser" = "t" ] || die 'the administrator connection cannot create databases (needs SUPERUSER or CREATEDB)'

role_exists() { # NAME
  [ "$(psql_scalar "$admin_url" "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = "1" ]
}
database_exists() { # NAME
  [ "$(psql_scalar "$admin_url" "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]
}

role_exists "$tessera_migrator" || die "destination role does not exist: $tessera_migrator"
role_exists "$tessera_app" || die "destination role does not exist: $tessera_app"
role_exists "$cadence_migrator" || die "destination role does not exist: $cadence_migrator"
role_exists "$cadence_app" || die "destination role does not exist: $cadence_app"
role_exists "$tessera_group" || die "destination group role does not exist: $tessera_group"
role_exists "$cadence_group" || die "destination group role does not exist: $cadence_group"
database_exists "$tessera_restore_database" && die "refusing to overwrite existing database: $tessera_restore_database"
database_exists "$cadence_restore_database" && die "refusing to overwrite existing database: $cadence_restore_database"

note 'Restore plan:'
note "  backup:            $backup_dir"
note "  tessera database:  $tessera_restore_database (owner $tessera_migrator, runtime role $tessera_app)"
note "  cadence database:  $cadence_restore_database (owner $cadence_migrator, runtime role $cadence_app)"
note "  restored env files and replay archive: $dest_dir"
note "  restored replay directory in a running Cadence: $replay_container_dir"
if [ "$dry_run" = "1" ]; then
  note 'Dry run: no database was created and no file was written.'
  exit 0
fi

mkdir -p "$dest_dir"
chmod 700 "$dest_dir"

# The administrator connection is re-parsed inside each helper so that no
# password from another connection string can leak into it.
admin_sql() { # DATABASE SQL
  parse_connection_url "$admin_url"
  PGPASSWORD="$URL_PASSWORD" "$(tool_path psql)" --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
    --dbname "$(url_with_database "$(url_without_password "$admin_url")" "$1")" --command "$2"
}

admin_sql_file() { # DATABASE FILE
  parse_connection_url "$admin_url"
  PGPASSWORD="$URL_PASSWORD" "$(tool_path psql)" --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
    --dbname "$(url_with_database "$(url_without_password "$admin_url")" "$1")" --file "$2"
}

admin_scalar() { # DATABASE SQL
  parse_connection_url "$admin_url"
  psql_scalar "$(url_with_database "$admin_url" "$1")" "$2"
}

note 'Creating isolated databases...'
admin_sql postgres "CREATE DATABASE \"$tessera_restore_database\" OWNER \"$tessera_migrator\""
admin_sql postgres "CREATE DATABASE \"$cadence_restore_database\" OWNER \"$cadence_migrator\""
admin_sql postgres "REVOKE CONNECT ON DATABASE \"$tessera_restore_database\" FROM PUBLIC"
admin_sql postgres "REVOKE CONNECT ON DATABASE \"$cadence_restore_database\" FROM PUBLIC"
admin_sql postgres "GRANT CONNECT ON DATABASE \"$tessera_restore_database\" TO \"$tessera_group\""
admin_sql postgres "GRANT CONNECT ON DATABASE \"$cadence_restore_database\" TO \"$cadence_group\""

# Restores as the destination migration role. The archive carries no ownership
# or ACL entries (--no-owner --no-acl), so every object ends up owned by the
# destination migration role, which is exactly the ownership the deployment
# expects before grants are re-applied.
restore_dump() { # DUMP URL LOG
  local dump="$1" url="$2" log="$3"
  parse_connection_url "$url"
  local target password
  target=$(url_without_password "$url")
  password=$URL_PASSWORD

  note "Restoring $(basename "$dump")..."
  if PGPASSWORD="$password" "$(tool_path pg_restore)" --no-owner --no-acl \
      --exit-on-error --single-transaction --dbname "$target" "$dump" >"$log" 2>&1; then
    return 0
  fi

  # A dump taken from a database whose public schema is the standard one may
  # still contain its creation; that single statement is the only tolerated
  # difference, and the retry restores everything else.
  local tolerated=0 unexpected=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *'error:'*|*'ERROR:'*)
        case "$line" in
          *'schema "public" already exists'*) tolerated=$((tolerated + 1)) ;;
          *) unexpected=$((unexpected + 1)) ;;
        esac
        ;;
    esac
  done <"$log"
  if [ "$tolerated" = "0" ] || [ "$unexpected" != "0" ]; then
    sed -n '1,40p' "$log" >&2
    die "pg_restore failed for $(basename "$dump")"
  fi

  note 'Retrying without a single transaction to tolerate the existing public schema...'
  if ! PGPASSWORD="$password" "$(tool_path pg_restore)" --no-owner --no-acl \
      --dbname "$target" "$dump" >"$log" 2>&1; then
    unexpected=0
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        *'error:'*|*'ERROR:'*)
          case "$line" in
            *'schema "public" already exists'*) : ;;
            *) unexpected=$((unexpected + 1)) ;;
          esac
          ;;
      esac
    done <"$log"
    if [ "$unexpected" != "0" ]; then
      sed -n '1,40p' "$log" >&2
      die "pg_restore reported unexpected errors for $(basename "$dump")"
    fi
    warn "restore of $(basename "$dump") tolerated the pre-existing public schema"
  fi
}

# Counts table-creation entries in an archive TOC without printing archive
# content. A TOC line is "dumpId; catalogOid objectOid TYPE namespace tag owner",
# so only entries whose type field is exactly TABLE are counted (ACL, TABLE DATA
# and TABLE ATTACH entries are not).
archive_table_count() { # DUMP
  local dump="$1" line count=0
  local -a fields=()
  while IFS= read -r line || [ -n "$line" ]; do
    read -r -a fields <<<"$line"
    [ "${fields[3]:-}" = "TABLE" ] || continue
    case "${fields[4]:-}" in
      DATA|ATTACH) continue ;;
    esac
    count=$((count + 1))
  done < <("$(tool_path pg_restore)" --list "$dump")
  printf '%s' "$count"
}

restore_dump "$backup_dir/tessera.dump" "$(url_with_database "$tessera_migration_url" "$tessera_restore_database")" "$dest_dir/.pg_restore-tessera.log"
restore_dump "$backup_dir/cadence.dump" "$(url_with_database "$cadence_migration_url" "$cadence_restore_database")" "$dest_dir/.pg_restore-cadence.log"

note 'Re-establishing runtime grants...'
admin_sql "$tessera_restore_database" "
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO \"$tessera_group\";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$tessera_group\";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$tessera_group\";
ALTER DEFAULT PRIVILEGES FOR ROLE \"$tessera_migrator\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$tessera_group\";
ALTER DEFAULT PRIVILEGES FOR ROLE \"$tessera_migrator\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$tessera_group\";
"
admin_sql "$cadence_restore_database" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
admin_sql_file "$cadence_restore_database" "$grant_sql"

note 'Copying the replay archive...'
if [ -e "$replay_out" ] && [ -n "$(ls -A "$replay_out" 2>/dev/null)" ]; then
  die "refusing to overwrite a non-empty replay directory: $replay_out"
fi
mkdir -p "$replay_out"
chmod 700 "$replay_out"
if [ -d "$backup_dir/replays" ]; then
  cp -a "$backup_dir/replays/." "$replay_out/"
fi

note 'Verifying the restore...'
check_equals() { # ACTUAL EXPECTED DESCRIPTION
  [ "$1" = "$2" ] || die "verification failed: $3 (got '$1', expected '$2')"
}

tessera_tables=$(admin_scalar "$tessera_restore_database" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
cadence_tables=$(admin_scalar "$cadence_restore_database" "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public', 'cadence')")
check_equals "$tessera_tables" "$(archive_table_count "$backup_dir/tessera.dump")" 'restored Tessera table count does not match the archive'
check_equals "$cadence_tables" "$(archive_table_count "$backup_dir/cadence.dump")" 'restored Cadence table count does not match the archive'

check_equals "$(psql_scalar "$admin_url" "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = '$tessera_app'")" "f" "$tessera_app has administrative role attributes"
check_equals "$(psql_scalar "$admin_url" "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = '$cadence_app'")" "f" "$cadence_app has administrative role attributes"
check_equals "$(admin_scalar "$tessera_restore_database" "SELECT has_database_privilege('$tessera_app', current_database(), 'CREATE')")" "f" "$tessera_app may create schemas in the restored database"
check_equals "$(admin_scalar "$cadence_restore_database" "SELECT has_database_privilege('$cadence_app', current_database(), 'CREATE')")" "f" "$cadence_app may create schemas in the restored database"
check_equals "$(admin_scalar "$tessera_restore_database" "SELECT has_schema_privilege('$tessera_app', 'public', 'CREATE')")" "f" "$tessera_app may create objects in the public schema"
check_equals "$(admin_scalar "$cadence_restore_database" "SELECT has_schema_privilege('$cadence_app', 'cadence', 'CREATE')")" "f" "$cadence_app may create objects in the cadence schema"
check_equals "$(admin_scalar "$tessera_restore_database" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(priv) WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT has_table_privilege('$tessera_app', c.oid, p.priv)")" "0" 'the Tessera runtime role lacks DML on restored tables'
check_equals "$(admin_scalar "$cadence_restore_database" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cadence' AND c.relkind IN ('r','p') AND NOT has_table_privilege('$cadence_app', c.oid, 'SELECT')")" "0" 'the Cadence runtime role lacks SELECT on restored tables'
check_equals "$(admin_scalar "$cadence_restore_database" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cadence' AND c.relkind IN ('r','p') AND c.relname IN ('matches','match_readers','replays','cloud_heads','cloud_versions','announcements','sanctions') AND NOT has_table_privilege('$cadence_app', c.oid, 'INSERT')")" "0" 'the Cadence runtime role lacks INSERT on restored tables'

tessera_accounts=$(psql_scalar "$(url_with_database "$tessera_runtime_url" "$tessera_restore_database")" 'SELECT count(*) FROM public."user"')
cadence_matches=$(psql_scalar "$(url_with_database "$cadence_runtime_url" "$cadence_restore_database")" 'SELECT count(*) FROM cadence.matches')
cadence_replays=$(psql_scalar "$(url_with_database "$cadence_runtime_url" "$cadence_restore_database")" 'SELECT count(*) FROM cadence.replays')
replay_files=$(find "$replay_out" -type f | wc -l)

rm -f "$dest_dir/.pg_restore-tessera.log" "$dest_dir/.pg_restore-cadence.log"

note 'Writing restored environment files...'
rewrite_env_file "$tessera_env" "$dest_dir/restored-tessera.env" \
  "DATABASE_URL=$(url_with_database "$tessera_runtime_url" "$tessera_restore_database")" \
  "MIGRATION_DATABASE_URL=$(url_with_database "$tessera_migration_url" "$tessera_restore_database")"
rewrite_env_file "$cadence_env" "$dest_dir/restored-cadence.env" \
  "DATABASE_URL=$(url_with_database "$cadence_runtime_url" "$cadence_restore_database")" \
  "MIGRATION_DATABASE_URL=$(url_with_database "$cadence_migration_url" "$cadence_restore_database")" \
  "CADENCE_REPLAY_DIR=$replay_container_dir"

created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf '{\n'
  printf '  "tool": "techmino-deploy-restore",\n'
  printf '  "formatVersion": 1,\n'
  printf '  "createdAt": %s,\n' "$(json_string "$created_at")"
  printf '  "backupDirectory": %s,\n' "$(json_string "$backup_dir")"
  printf '  "databases": [\n'
  printf '    {"product": "tessera", "database": %s, "owner": %s, "runtimeRole": %s},\n' "$(json_string "$tessera_restore_database")" "$(json_string "$tessera_migrator")" "$(json_string "$tessera_app")"
  printf '    {"product": "cadence", "database": %s, "owner": %s, "runtimeRole": %s}\n' "$(json_string "$cadence_restore_database")" "$(json_string "$cadence_migrator")" "$(json_string "$cadence_app")"
  printf '  ],\n'
  printf '  "replays": {"directory": %s, "fileCount": %s, "containerPath": %s},\n' "$(json_string "$replay_out")" "$replay_files" "$(json_string "$replay_container_dir")"
  printf '  "observed": {"tesseraAccounts": %s, "cadenceMatches": %s, "cadenceReplays": %s},\n' "$tessera_accounts" "$cadence_matches" "$cadence_replays"
  printf '  "environmentFiles": ["restored-tessera.env", "restored-cadence.env"]\n'
  printf '}\n'
} >"$dest_dir/restore-manifest.json"
chmod 600 "$dest_dir/restore-manifest.json"

note 'Restore complete.'
note "  tessera: $tessera_restore_database ($tessera_accounts account row(s))"
note "  cadence: $cadence_restore_database ($cadence_matches match row(s), $cadence_replays replay row(s))"
note "  replays: $replay_files file(s) in $replay_out (mount at $replay_container_dir)"
note "  environment files: $dest_dir/restored-tessera.env, $dest_dir/restored-cadence.env"
note 'The source databases were not modified.'
