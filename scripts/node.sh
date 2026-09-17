#!/usr/bin/env bash
# Run a command in a Node 22 container against this repo.
#
# The development host has no node (ostree system), so every npm and wrangler
# command goes through here:
#
#   ./scripts/node.sh npm install
#   ./scripts/node.sh npm run check
#   ./scripts/node.sh --serve npm run dev      # http://127.0.0.1:8787
#   ./scripts/node.sh --login npx wrangler login
#   ./scripts/node.sh --cloudflare npm run deploy
#
# --serve publishes port 8787 and belongs only to the dev server. Without it no
# port is published, which is what lets a one-off command run while the dev
# server is up; publishing an already-bound port kills the container.
#
# --login publishes 8976, where Cloudflare's OAuth redirect lands.
#
# --cloudflare is the only way an account token reaches the container. Ordinary
# commands — install, tests, typecheck — never see production credentials.
#
# --net-host shares the host's network, which is how one container reaches the
# dev server running in another:
#
#   ./scripts/node.sh --net-host node dev/two-phones.mjs
#
# The container's HOME is a directory on the host, so a wrangler login and the
# npm cache survive between commands instead of dying with the container.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_home="${VAUVAPELI_CONTAINER_HOME:-$HOME/.local/share/vauvapeli/home}"
mkdir -p "$container_home"

serve=0
login=0
with_cloudflare=0
net_host=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --serve) serve=1; shift ;;
    --login) login=1; shift ;;
    --cloudflare) with_cloudflare=1; shift ;;
    --net-host) net_host=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

[ "$#" -gt 0 ] || { echo "usage: node.sh [--serve|--login] [--cloudflare] command ..." >&2; exit 2; }

if [ "$serve" = "1" ] && [ "$login" = "1" ]; then
  echo "--serve and --login cannot be used together" >&2
  exit 2
fi

port_flags=()
if [ "$serve" = "1" ]; then
  port_flags=(-p 127.0.0.1:8787:8787)
elif [ "$login" = "1" ]; then
  port_flags=(-p 127.0.0.1:8976:8976)
fi

# -i always, so a piped stdin reaches the command (wrangler secret put reads it).
run_flags=(-i)
[ -t 0 ] && run_flags+=(-t)

cloudflare_flags=()
if [ "$with_cloudflare" = "1" ]; then
  # Read from a file outside the repository, mode 600. See README.
  env_file="${VAUVAPELI_CLOUDFLARE_ENV:-$HOME/.local/share/vauvapeli/cloudflare.env}"
  if [ -r "$env_file" ]; then
    # shellcheck disable=SC1090
    set -a; . "$env_file"; set +a
  fi
  # Forwarded by name, never by value, so a token stays out of the command line.
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && cloudflare_flags+=(-e CLOUDFLARE_API_TOKEN)
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && cloudflare_flags+=(-e CLOUDFLARE_ACCOUNT_ID)
fi

net_flags=()
[ "$net_host" = "1" ] && net_flags=(--network host)

exec podman run --rm "${run_flags[@]}" "${port_flags[@]}" "${cloudflare_flags[@]}" "${net_flags[@]}" \
  -v "$repo":/app:Z \
  -v "$container_home":/home/dev:Z \
  -w /app \
  -e HOME=/home/dev \
  --userns=keep-id \
  docker.io/library/node:22-bookworm \
  "$@"
