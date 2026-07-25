#!/usr/bin/env bash
# Runtime setup for the integration image. Everything here happens on each
# container start, on purpose: openclaw and cursor-agent are pulled fresh so a
# breaking upstream release shows up as a red test run rather than being
# masked by a cached image layer.
set -euo pipefail

log() { printf '==> %s\n' "$*" >&2; }
since() { printf '%s' "$(( $(date +%s) - $1 ))"; }

if [ "$(id -u)" = "0" ]; then
  echo "refusing to run as root: root bypasses chmod 000, and 8 permission-denied tests in the unit suite then fail" >&2
  exit 1
fi

# The checkout arrives read-only at /src and is copied into a container-local
# /work. Mounting it directly does not work: node_modules has to be
# container-local (Biome ships a per-platform binary, and the host tree is the
# wrong platform), and a tmpfs cannot be mounted over a path that does not
# exist inside a read-only bind — which is exactly a fresh CI checkout.
if [ ! -d /src ]; then
  echo "expected the checkout mounted read-only at /src" >&2
  exit 1
fi
log "copying /src -> /work (excluding node_modules and .git)"
tar -C /src --exclude=node_modules --exclude=.git -cf - . | tar -C /work -xf -

t0=$(date +%s)
log "npm ci (repo devDependencies, linux binaries)"
npm ci --no-audit --no-fund
log "npm ci took $(since "$t0")s"

# `openclaw` is a peerDependency the gateway normally provides. src/index.ts
# imports `openclaw/plugin-sdk/*` at runtime, so the suite needs it linked in
# even though the package must not depend on it.
t1=$(date +%s)
log "npm install -g openclaw"
npm install -g --no-audit --no-fund openclaw
npm link openclaw
log "openclaw install+link took $(since "$t1")s ($(openclaw --version 2>/dev/null || echo 'version unknown'))"

# cursor-agent unpacks into $HOME/.local (already on PATH). Optional: the unit
# suite stubs the binary, so a network hiccup must not fail the whole run.
t2=$(date +%s)
if [ "${SKIP_CURSOR_AGENT:-0}" = "1" ]; then
  log "cursor-agent install skipped (SKIP_CURSOR_AGENT=1)"
else
  log "installing cursor-agent into \$HOME/.local"
  if curl -fsS https://cursor.com/install | bash; then
    log "cursor-agent install took $(since "$t2")s ($(cursor-agent --version 2>/dev/null || echo 'version unknown'))"
  else
    log "cursor-agent install FAILED after $(since "$t2")s (continuing; suite stubs the binary)"
  fi
fi

log "total runtime setup: $(since "$t0")s"
log "exec: $*"
exec "$@"
