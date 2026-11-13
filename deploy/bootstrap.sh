#!/usr/bin/env bash
# Operator bootstrap for the self-hosted Techmino online stack.
#
# It reads deploy/.env (a copy of deploy/.env.example with every placeholder
# replaced), validates it, generates the deployment secrets, copies operator
# TLS material in manual mode, and writes the protected runtime environment
# files used by deploy/compose.yml.
#
# Guarantees:
#   * fresh only: an existing deploy/runtime directory is never overwritten;
#   * nothing secret is printed, logged, or written outside deploy/runtime;
#   * no database, mail service, or remote host is contacted or modified.
#
# Usage:
#   deploy/bootstrap.sh [--dry-run]
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/tools/common.sh"

dotenv="$script_dir/.env"
runtime="$script_dir/runtime"
dry_run=0

usage() { sed -n '2,19p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_command openssl
[ -f "$dotenv" ] || die "deploy/.env is missing: copy deploy/.env.example, replace every placeholder, then rerun"

# Strict parse: KEY=VALUE lines only, known keys only, and no value is echoed.
declare -A values=()
known_keys=' APP_ENV ACCOUNT_HOST ACCOUNT_PORT GAME_HOST GAME_PORT PROXY_BIND TLS_MODE
 ACCOUNT_TLS_CERT ACCOUNT_TLS_KEY GAME_TLS_CERT GAME_TLS_KEY TESSERA_UPSTREAM_CA
 TESSERA_REPO_DIR CADENCE_REPO_DIR TECHMINO_SOURCE_DIR WEBSITE_REPO_DIR
 GAME_ROOTS_DIR BACKUP_DIR RESTORED_DIR IMAGE_TAG
 MAIL_MODE SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM
 ACCOUNT_ADMIN_IDS CADENCE_GAME_ADMINS MAILPIT_SMTP_PORT MAILPIT_HTTP_PORT '
known_keys=${known_keys//$'\n'/ }
line_number=0
while IFS= read -r line || [ -n "$line" ]; do
  line_number=$((line_number + 1))
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in
    *=*) : ;;
    *) die "deploy/.env line $line_number is not a KEY=VALUE assignment" ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  case "$known_keys" in
    *" $key "*) values["$key"]=$value ;;
    *) die "deploy/.env line $line_number uses an unknown key: $key" ;;
  esac
done <"$dotenv"

value_of() { printf '%s' "${values[$1]:-}"; }

require_key() { # KEY
  [ -n "$(value_of "$1")" ] || die "deploy/.env must define $1"
}

reject_placeholder() { # KEY
  case "$(value_of "$1")" in
    *REPLACE_WITH*) die "deploy/.env still contains the template placeholder for $1" ;;
  esac
}

require_clean() { require_key "$1"; reject_placeholder "$1"; }

for key in APP_ENV ACCOUNT_HOST ACCOUNT_PORT GAME_HOST GAME_PORT \
  MAIL_MODE SMTP_FROM; do
  require_clean "$key"
done

app_env=$(value_of APP_ENV)
case "$app_env" in
  production|development) : ;;
  *) die 'APP_ENV must be production or development' ;;
esac

mail_mode=$(value_of MAIL_MODE)
case "$mail_mode" in
  smtp)
    [ "$app_env" = "production" ] || die 'MAIL_MODE=smtp requires APP_ENV=production'
    require_clean SMTP_HOST
    require_clean SMTP_PORT
    require_clean SMTP_USER
    require_clean SMTP_PASSWORD
    ;;
  local-fixture)
    [ "$app_env" = "development" ] || die 'MAIL_MODE=local-fixture requires APP_ENV=development; it is the isolated fixture only'
    ;;
  *) die 'MAIL_MODE must be smtp or local-fixture' ;;
esac

for key in ACCOUNT_HOST GAME_HOST; do
  case "$(value_of "$key")" in
    ''|*[!A-Za-z0-9.-]*) die "$key must be a plain hostname" ;;
  esac
done
port_keys='ACCOUNT_PORT GAME_PORT'
if [ "$mail_mode" = "smtp" ]; then port_keys="$port_keys SMTP_PORT"; fi
for key in $port_keys; do
  case "$(value_of "$key")" in
    ''|*[!0-9]*) die "$key must be a decimal port number" ;;
  esac
  [ "$(value_of "$key")" -ge 1 ] && [ "$(value_of "$key")" -le 65535 ] || die "$key must be between 1 and 65535"
done

account_host=$(value_of ACCOUNT_HOST)
game_host=$(value_of GAME_HOST)
account_port=$(value_of ACCOUNT_PORT)
game_port=$(value_of GAME_PORT)
account_origin="https://$account_host"
game_origin="https://$game_host"
[ "$account_port" = "443" ] || account_origin="$account_origin:$account_port"
[ "$game_port" = "443" ] || game_origin="$game_origin:$game_port"

tls_mode=$(value_of TLS_MODE)
[ -n "$tls_mode" ] || tls_mode=manual
case "$tls_mode" in
  manual)
    for key in ACCOUNT_TLS_CERT ACCOUNT_TLS_KEY GAME_TLS_CERT GAME_TLS_KEY; do
      require_clean "$key"
    done
    ;;
  automatic)
    [ "$account_port" = 443 ] && [ "$game_port" = 443 ] || die 'TLS_MODE=automatic requires both public ports to be 443'
    [ -z "$(value_of TESSERA_UPSTREAM_CA)" ] || die 'TLS_MODE=automatic uses public trust roots; leave TESSERA_UPSTREAM_CA empty'
    ;;
  *) die 'TLS_MODE must be manual or automatic' ;;
esac

resolve_dir() { # DIR
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$script_dir" "${1#./}" ;;
  esac
}

check_pem() { # FILE MARKER DESCRIPTION
  [ -f "$1" ] || die "$3 not found: $1"
  [ -s "$1" ] || die "$3 is empty: $1"
  [ "$(wc -c <"$1")" -le 131072 ] || die "$3 exceeds 128 KiB: $1"
  grep -q -- "$2" "$1" || die "$3 does not look like PEM content: $1"
}

account_tls_cert=$(value_of ACCOUNT_TLS_CERT)
account_tls_key=$(value_of ACCOUNT_TLS_KEY)
game_tls_cert=$(value_of GAME_TLS_CERT)
game_tls_key=$(value_of GAME_TLS_KEY)
if [ "$tls_mode" = "manual" ]; then
  check_pem "$account_tls_cert" 'BEGIN CERTIFICATE' 'ACCOUNT_TLS_CERT'
  check_pem "$game_tls_cert" 'BEGIN CERTIFICATE' 'GAME_TLS_CERT'
  check_pem "$account_tls_key" 'PRIVATE KEY' 'ACCOUNT_TLS_KEY'
  check_pem "$game_tls_key" 'PRIVATE KEY' 'GAME_TLS_KEY'
fi
upstream_ca=$(value_of TESSERA_UPSTREAM_CA)
if [ -n "$upstream_ca" ]; then
  reject_placeholder TESSERA_UPSTREAM_CA
  check_pem "$upstream_ca" 'BEGIN CERTIFICATE' 'TESSERA_UPSTREAM_CA'
fi

game_roots=$(value_of GAME_ROOTS_DIR)
backup_dir=$(value_of BACKUP_DIR)
restored_dir=$(value_of RESTORED_DIR)
[ -n "$game_roots" ] || game_roots='./game-roots'
[ -n "$backup_dir" ] || backup_dir='./backups'
[ -n "$restored_dir" ] || restored_dir='./restored'
game_roots=$(resolve_dir "$game_roots")
backup_dir=$(resolve_dir "$backup_dir")
restored_dir=$(resolve_dir "$restored_dir")

if [ -e "$runtime" ]; then
  die "refusing to overwrite the existing generated configuration: $runtime (remove it deliberately to regenerate)"
fi

note 'Bootstrap plan:'
note "  environment:        $app_env"
note "  account origin:     $account_origin"
note "  game origin:        $game_origin"
note "  mail mode:          $mail_mode"
note "  TLS mode:           $tls_mode"
note "  generated files:    $runtime/{postgres.env,tessera.env,cadence.env,postgres-admin.url,tls/}"
note "  directories:        $game_roots/play, $backup_dir, $restored_dir"
if [ "$dry_run" = "1" ]; then
  note 'Dry run: nothing was generated.'
  exit 0
fi

mkdir -p "$runtime/tls"
chmod 700 "$runtime" "$runtime/tls"
if [ "$tls_mode" = "manual" ]; then
  cp "$account_tls_cert" "$runtime/tls/account.pem"
  cp "$account_tls_key" "$runtime/tls/account.key"
  cp "$game_tls_cert" "$runtime/tls/game.pem"
  cp "$game_tls_key" "$runtime/tls/game.key"
  # Public certificates remain readable by the unprivileged Cadence process;
  # private keys stay 0600.
  chmod 644 "$runtime/tls/account.pem" "$runtime/tls/game.pem"
  chmod 600 "$runtime/tls/account.key" "$runtime/tls/game.key"
fi
if [ -n "$upstream_ca" ]; then
  cp "$upstream_ca" "$runtime/tls/account-ca.pem"
  chmod 644 "$runtime/tls/account-ca.pem"
fi

postgres_password=$(openssl rand -hex 32)
tessera_migrator_password=$(openssl rand -hex 32)
tessera_app_password=$(openssl rand -hex 32)
cadence_migrator_password=$(openssl rand -hex 32)
cadence_app_password=$(openssl rand -hex 32)
better_auth_secret=$(openssl rand -hex 48)
resource_secret=$(openssl rand -hex 32)

write_env() { # FILE CONTENT... (content is written with mode 0600 and never echoed)
  local file="$1"
  shift
  local tmp="$file.tmp"
  printf '%s\n' "$@" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

if [ "$mail_mode" = "local-fixture" ]; then
  smtp_host=mailpit
  smtp_port=1025
  smtp_secure=false
  smtp_require_tls=false
  smtp_user=''
  smtp_password=''
else
  smtp_host=$(value_of SMTP_HOST)
  smtp_port=$(value_of SMTP_PORT)
  smtp_secure=$(value_of SMTP_SECURE)
  [ -n "$smtp_secure" ] || smtp_secure=false
  smtp_require_tls=true
  smtp_user=$(value_of SMTP_USER)
  smtp_password=$(value_of SMTP_PASSWORD)
fi
smtp_from=$(value_of SMTP_FROM)

write_env "$runtime/postgres.env" \
  'POSTGRES_USER=techmino_admin' \
  'POSTGRES_DB=postgres' \
  "POSTGRES_PASSWORD=$postgres_password" \
  "TESSERA_MIGRATOR_PASSWORD=$tessera_migrator_password" \
  "TESSERA_APP_PASSWORD=$tessera_app_password" \
  "CADENCE_MIGRATOR_PASSWORD=$cadence_migrator_password" \
  "CADENCE_APP_PASSWORD=$cadence_app_password"

write_env "$runtime/postgres-admin.url" \
  "postgresql://techmino_admin:$postgres_password@postgres:5432/postgres"

write_env "$runtime/tessera.env" \
  "NODE_ENV=$app_env" \
  "PUBLIC_ORIGIN=$account_origin" \
  'HOST=0.0.0.0' \
  'PORT=17436' \
  "CORS_ORIGINS=$account_origin" \
  'TRUSTED_PROXY_IPS=172.28.0.10' \
  "DATABASE_URL=postgresql://techmino_tessera_app:$tessera_app_password@postgres:5432/techmino_tessera" \
  "MIGRATION_DATABASE_URL=postgresql://techmino_tessera_migrator:$tessera_migrator_password@postgres:5432/techmino_tessera" \
  "BETTER_AUTH_SECRET=$better_auth_secret" \
  "RESOURCE_KEYS=[{\"id\":\"cadence-primary\",\"secret\":\"$resource_secret\",\"products\":[\"techmino\",\"techminoGalaxy\"]}]" \
  "ACCOUNT_ADMIN_IDS=$(value_of ACCOUNT_ADMIN_IDS)" \
  "SMTP_HOST=$smtp_host" \
  "SMTP_PORT=$smtp_port" \
  "SMTP_SECURE=$smtp_secure" \
  "SMTP_REQUIRE_TLS=$smtp_require_tls" \
  "SMTP_USER=$smtp_user" \
  "SMTP_PASSWORD=$smtp_password" \
  "SMTP_FROM=$smtp_from" \
  "TECHMINO_WEB_CALLBACKS=$account_origin/play/techmino/" \
  "GALAXY_WEB_CALLBACKS=$account_origin/play/techmino-galaxy/"

cadence_env=(
  "DATABASE_URL=postgresql://techmino_cadence_app:$cadence_app_password@postgres:5432/techmino_cadence"
  "MIGRATION_DATABASE_URL=postgresql://techmino_cadence_migrator:$cadence_migrator_password@postgres:5432/techmino_cadence"
  'CADENCE_BIND=172.28.0.21:17437'
  'CADENCE_DEV=false'
  "TESSERA_ORIGIN=$account_origin"
  "TESSERA_RESOURCE_SECRET=$resource_secret"
  "CADENCE_PUBLIC_ORIGIN=$game_origin"
  "CADENCE_ALLOWED_ORIGINS=$account_origin,$game_origin"
  'CADENCE_TRUSTED_PROXIES=172.28.0.10/32'
  "CADENCE_GAME_ADMINS=$(value_of CADENCE_GAME_ADMINS)"
  'CADENCE_REPLAY_DIR=/var/lib/cadence/replays'
)
if [ -n "$upstream_ca" ]; then
  cadence_env+=('CADENCE_TESSERA_CA_FILE=/run/tessera-ca/account-ca.pem')
fi
write_env "$runtime/cadence.env" "${cadence_env[@]}"

mkdir -p "$game_roots/play" "$backup_dir" "$restored_dir"
chmod 755 "$game_roots" "$game_roots/play"
chmod 700 "$backup_dir" "$restored_dir"

note 'Bootstrap complete. Secret files are mode 0600 inside a 0700 directory.'
note "  $runtime/postgres.env"
note "  $runtime/tessera.env"
note "  $runtime/cadence.env"
note "  $runtime/postgres-admin.url"
if [ "$tls_mode" = "manual" ]; then
  note "  $runtime/tls/ (account.pem and game.pem 0644 public certificates, account.key and game.key 0600${upstream_ca:+, account-ca.pem 0644})"
else
  note '  public certificates are managed by Caddy in the persistent proxy-data volume'
fi
note ''
note 'Next steps:'
if [ "$tls_mode" = "automatic" ]; then
  note '  docker compose -f deploy/compose.yml -f deploy/compose.public.yml config --quiet'
  note '  docker compose -f deploy/compose.yml -f deploy/compose.public.yml up --build -d'
else
  note '  docker compose -f deploy/compose.yml config --quiet'
  note '  docker compose -f deploy/compose.yml up --build -d'
fi
if [ "$mail_mode" = "local-fixture" ]; then
  note '  the local mail fixture needs: docker compose -f deploy/compose.yml --profile local-mail up -d mailpit'
fi
note '  populate the game roots with the real Web/WASM release builds before testing web play'
