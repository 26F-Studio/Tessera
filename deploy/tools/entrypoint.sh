#!/usr/bin/env bash
# Entry point for the `tools` compose service. Subcommands run the deployment
# backup and restore tools; anything else is executed directly, which allows
# `docker compose run --rm tools psql ...` style inspection.
set -euo pipefail

case "${1:-help}" in
  backup) exec /opt/tools/backup.sh "${@:2}" ;;
  restore) exec /opt/tools/restore.sh "${@:2}" ;;
  help|-h|--help)
    cat <<'USAGE'
Usage: docker compose --profile tools run --rm tools <subcommand> [options]

  backup   Write both database dumps, the replay archive and a manifest into a
           new backup directory. Requires drained services.
  restore  Restore a backup into isolated new databases on the destination
           deployment, then verify runtime roles and privileges.
  <command>  Any other argument is executed as a command inside the container.
USAGE
    ;;
  *) exec "$@" ;;
esac
