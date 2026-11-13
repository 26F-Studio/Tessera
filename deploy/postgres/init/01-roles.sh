#!/bin/bash
# Least-privilege roles and the two application databases.
#
# The official PostgreSQL entrypoint executes this file once, as the superuser,
# when the data directory is first initialized. Passwords come from the generated
# environment file (see deploy/runtime/postgres.env) and are never printed.
#
# Shape of the deployment:
#   * <product>_migrator  LOGIN, owns the database and every object, runs DDL,
#                         NOT superuser/createdb/createrole
#   * <product>_app       LOGIN, member of the product group, DML only, no DDL
#   * tessera_application NOLOGIN group carrying the Tessera runtime grants
#   * cadence_application NOLOGIN group carrying the Cadence runtime grants
#                         (referenced by techmino-cadence's sql/grant-application.sql)
#
# Do not rename the group roles without also updating that grant file.
#
# Any failure here is fatal: the script exits non-zero, which aborts the
# container's first start instead of leaving an unprovisioned database behind.
set -euo pipefail

export PGPASSWORD="${POSTGRES_PASSWORD:-}"
admin_user="${POSTGRES_USER:?POSTGRES_USER must be provided by the image}"

# psql does not interpolate variables inside -c strings, so every statement is
# fed through standard input.
psql_scalar() { # SQL [--set=NAME=VALUE ...]
  local statement="$1"
  shift
  printf '%s\n' "$statement" | psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
    --username "$admin_user" --dbname postgres --tuples-only --no-align "$@"
}

psql_exec() { # SQL [--set=NAME=VALUE ...]
  local statement="$1"
  shift
  printf '%s\n' "$statement" | psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
    --username "$admin_user" --dbname postgres "$@"
}

psql_exec_in() { # DATABASE SQL [--set=NAME=VALUE ...]
  local db="$1" statement="$2"
  shift 2
  printf '%s\n' "$statement" | psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
    --username "$admin_user" --dbname "$db" "$@"
}

role_exists() { # NAME
  [ "$(psql_scalar "SELECT 1 FROM pg_roles WHERE rolname = :'role'" --set=role="$1")" = "1" ]
}

database_exists() { # NAME
  [ "$(psql_scalar "SELECT 1 FROM pg_database WHERE datname = :'db'" --set=db="$1")" = "1" ]
}

create_group_role() { # NAME
  if role_exists "$1"; then return 0; fi
  psql_exec "CREATE ROLE :\"role\" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" --set=role="$1"
}

create_login_role() { # NAME PASSWORD
  if role_exists "$1"; then return 0; fi
  if [ -z "${2:-}" ]; then
    echo "error: refusing to create login role $1 without a generated password" >&2
    exit 1
  fi
  psql_exec "CREATE ROLE :\"role\" LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" --set=role="$1" --set=pw="$2"
}

create_database() { # DATABASE OWNER
  if database_exists "$1"; then return 0; fi
  psql_exec "CREATE DATABASE :\"db\" OWNER :\"own\"" --set=db="$1" --set=own="$2"
}

# Runtime roles reach their schema but never own it and never create objects.
grant_runtime_schema() { # DATABASE OWNER GROUP
  local db="$1" owner="$2" group="$3"
  psql_exec_in "$db" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
  psql_exec_in "$db" "GRANT USAGE ON SCHEMA public TO :\"grp\"" --set=grp="$group"
  psql_exec_in "$db" "ALTER DEFAULT PRIVILEGES FOR ROLE :\"own\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :\"grp\"" --set=own="$owner" --set=grp="$group"
  psql_exec_in "$db" "ALTER DEFAULT PRIVILEGES FOR ROLE :\"own\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :\"grp\"" --set=own="$owner" --set=grp="$group"
}

create_group_role tessera_application
create_group_role cadence_application

create_login_role techmino_tessera_migrator "${TESSERA_MIGRATOR_PASSWORD:-}"
create_login_role techmino_tessera_app "${TESSERA_APP_PASSWORD:-}"
create_login_role techmino_cadence_migrator "${CADENCE_MIGRATOR_PASSWORD:-}"
create_login_role techmino_cadence_app "${CADENCE_APP_PASSWORD:-}"

psql_exec "GRANT tessera_application TO techmino_tessera_app"
psql_exec "GRANT cadence_application TO techmino_cadence_app"

create_database techmino_tessera techmino_tessera_migrator
create_database techmino_cadence techmino_cadence_migrator

psql_exec "REVOKE CONNECT ON DATABASE techmino_tessera FROM PUBLIC"
psql_exec "REVOKE CONNECT ON DATABASE techmino_cadence FROM PUBLIC"
psql_exec "GRANT CONNECT ON DATABASE techmino_tessera TO tessera_application"
psql_exec "GRANT CONNECT ON DATABASE techmino_cadence TO cadence_application"

# Tessera keeps its account and product tables in the public schema.
grant_runtime_schema techmino_tessera techmino_tessera_migrator tessera_application

# Cadence's tables live in the cadence schema, which its migration creates; the
# DML grants are applied by `techmino-cadence migrate` from sql/grant-application.sql.
psql_exec_in techmino_cadence "REVOKE ALL ON SCHEMA public FROM PUBLIC"

# Verify the provisioning actually landed before reporting success.
for role in tessera_application cadence_application techmino_tessera_migrator techmino_tessera_app techmino_cadence_migrator techmino_cadence_app; do
  if ! role_exists "$role"; then
    echo "error: deployment role was not created: $role" >&2
    exit 1
  fi
done
for db in techmino_tessera techmino_cadence; do
  if ! database_exists "$db"; then
    echo "error: deployment database was not created: $db" >&2
    exit 1
  fi
done

echo "Deployment roles and databases initialized"
