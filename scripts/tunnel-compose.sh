#!/bin/sh
# Invoke with sh; no executable-bit change, sudo, or host service needed.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
TUNNEL_UID=$(id -u)
TUNNEL_GID=$(id -g)
export TUNNEL_UID TUNNEL_GID
if [ "$TUNNEL_UID" -eq 0 ] || [ "$TUNNEL_GID" -eq 0 ]; then
    echo "Run as the ordinary user who owns the SSH key, without sudo." >&2
    exit 1
fi
exec docker compose -p soap-asr-tunnel --env-file "${TUNNEL_ENV_FILE:-.env.tunnel}" \
    -f compose.tunnel.yml "$@"
