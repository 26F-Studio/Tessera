#!/usr/bin/env bash
# Shared helpers for the deployment backup and restore tools.
#
# These tools never print connection URLs, passwords, or secrets. They read
# protected environment files and hand connection strings to PostgreSQL clients
# through the environment, so credentials do not appear in the process list.

set -o pipefail

tool_path() { # command
  if [ -n "${PG_TOOLS_BIN:-}" ]; then printf '%s/%s' "$PG_TOOLS_BIN" "$1"; else printf '%s' "$1"; fi
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }
note() { printf '%s\n' "$*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_pg_tools() {
  require_command "$(tool_path pg_dump)"
  require_command "$(tool_path pg_restore)"
  require_command "$(tool_path psql)"
}

# Generated fixture dotenv files may quote URL values. Never evaluate their text.
unquote_env_value() {
  local value="$1"
  case "$value" in
    \"*\"|\'*\') value=${value:1:${#value}-2} ;;
  esac
  printf '%s' "$value"
}

# env_value FILE KEY -> the value of KEY, or a failure when it is absent.
env_value() {
  local file="$1" key="$2" line value=''
  [ -f "$file" ] || die "environment file not found: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in
      "$key"=*) value=${line#"$key"=} ;;
    esac
  done <"$file"
  [ -n "$value" ] || die "missing $key in $file"
  unquote_env_value "$value"
}

env_file_has_key() { # FILE KEY
  local file="$1" key="$2" line
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key"=*) return 0 ;; esac
  done <"$file"
  return 1
}

# parse_connection_url URL
# Sets URL_SCHEME, URL_USER, URL_PASSWORD, URL_HOSTPORT and URL_DATABASE.
# Passwords must not need percent-encoding; generated deployment secrets are
# hexadecimal and satisfy that.
parse_connection_url() {
  local url="$1" rest authority credentials path
  case "$url" in
    *://*) URL_SCHEME=${url%%://*} ;;
    *) die 'connection URLs must include a scheme' ;;
  esac
  rest=${url#*://}
  authority=${rest%%/*}
  path=${rest#*/}
  case "$authority" in
    *@*)
      credentials=${authority%%@*}
      URL_HOSTPORT=${authority#*@}
      case "$credentials" in
        *:*) URL_USER=${credentials%%:*}; URL_PASSWORD=${credentials#*:} ;;
        *) URL_USER=$credentials; URL_PASSWORD='' ;;
      esac
      ;;
    *) URL_USER=''; URL_PASSWORD=''; URL_HOSTPORT=$authority ;;
  esac
  URL_DATABASE=${path%%\?*}
  URL_QUERY=''
  case "$path" in *\?*) URL_QUERY="?${path#*\?}" ;; esac
  [ -n "$URL_HOSTPORT" ] || die 'connection URL is missing a host'
  [ -n "$URL_DATABASE" ] || die 'connection URL is missing a database name'
}

url_without_password() { # URL
  local url="$1" scheme rest authority credentials hostport user
  scheme=${url%%://*}
  rest=${url#*://}
  authority=${rest%%/*}
  case "$authority" in
    *@*)
      credentials=${authority%%@*}
      hostport=${authority#*@}
      user=${credentials%%:*}
      printf '%s://%s@%s/%s' "$scheme" "$user" "$hostport" "${rest#*/}"
      ;;
    *) printf '%s' "$url" ;;
  esac
}

url_with_database() { # URL NAME -> URL with the database component replaced
  local url="$1" name="$2" scheme rest authority path query=''
  scheme=${url%%://*}
  rest=${url#*://}
  authority=${rest%%/*}
  path=${rest#*/}
  case "$path" in *\?*) query="?${path#*\?}" ;; esac
  printf '%s://%s/%s%s' "$scheme" "$authority" "$name" "$query"
}

# read_admin_url FILE -> the first connection URL found in a bare URL file or in
# a dotenv file that defines PGADMIN_URL, ADMIN_DATABASE_URL or DATABASE_URL.
read_admin_url() {
  local file="$1" line found=''
  [ -f "$file" ] || die "administrator URL file not found: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [ -n "$found" ] && continue
    case "$line" in
      PGADMIN_URL=*) found=${line#PGADMIN_URL=} ;;
      ADMIN_DATABASE_URL=*) found=${line#ADMIN_DATABASE_URL=} ;;
      DATABASE_URL=*) found=${line#DATABASE_URL=} ;;
      *://*) found=$line ;;
    esac
  done <"$file"
  [ -n "$found" ] || die "no administrator connection URL found in $file"
  unquote_env_value "$found"
}

psql_url() { # URL [psql arguments...]
  local url="$1"; shift
  require_command "$(tool_path psql)"
  parse_connection_url "$url"
  PGPASSWORD="$URL_PASSWORD" "$(tool_path psql)" --no-psqlrc --no-password \
    --set=ON_ERROR_STOP=1 --dbname "$(url_without_password "$url")" "$@"
}

psql_scalar() { # URL SQL
  psql_url "$1" --tuples-only --no-align --command "$2" | tr -d '\r'
}

# client_connection_count URL -> sessions connected to the same database other
# than this one. PostgreSQL restricts some columns (for example backend_type)
# for other users' sessions, so the query deliberately filters only on datname
# and pid, which stay visible.
client_connection_count() {
  psql_scalar "$1" "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
}

# require_no_clients URL LABEL
require_no_clients() {
  local count
  count=$(client_connection_count "$1") || die "cannot inspect $2"
  [ "$count" = "0" ] || die "$2 still has $count client connection(s); drain the services and retry"
}

# rewrite_env_file SRC DEST KEY=VALUE...
# Copies SRC to DEST (mode 0600), replacing listed keys and appending absent ones.
rewrite_env_file() {
  local src="$1" dest="$2"
  shift 2
  [ -f "$src" ] || die "environment file not found: $src"
  {
    local line key pair replaced
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|'#'*) printf '%s\n' "$line"; continue ;;
      esac
      case "$line" in
        *=*) : ;;
        *) printf '%s\n' "$line"; continue ;;
      esac
      key=${line%%=*}
      replaced=0
      for pair in "$@"; do
        if [ "$key" = "${pair%%=*}" ]; then
          printf '%s=%s\n' "$key" "${pair#*=}"
          replaced=1
          break
        fi
      done
      [ "$replaced" = "1" ] || printf '%s\n' "$line"
    done <"$src"
    for pair in "$@"; do
      env_file_has_key "$src" "${pair%%=*}" || printf '%s=%s\n' "${pair%%=*}" "${pair#*=}"
    done
  } >"$dest"
  chmod 600 "$dest"
}

# json_string TEXT -> a quoted JSON string.
json_string() {
  local text="$1"
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/ }
  printf '"%s"' "$text"
}
