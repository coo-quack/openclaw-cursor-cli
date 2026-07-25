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
# The excludes are not just about size. /src is a bind mount, so it bypasses
# .dockerignore entirely: whatever a contributor keeps in their checkout —
# a .env, their own .cursor/ — would otherwise be copied into the container
# alongside the code. CI checkouts have none of this; local ones might.
tar -C /src \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.env \
  --exclude='.env.*' \
  --exclude=.cursor \
  --exclude=docs/notes \
  --exclude='*.log' \
  -cf - . | tar -C /work -xf -

t0=$(date +%s)
log "pnpm install --frozen-lockfile (repo devDependencies, linux binaries)"
pnpm install --frozen-lockfile
log "pnpm install took $(since "$t0")s"

# That install also brings in `openclaw` itself, at the version the lockfile
# pins: pnpm resolves the optional peer whether or not it is asked to, so
# `tsc` and the unit tests get their `openclaw/plugin-sdk/*` for free.
#
# The CLI is a separate question. The integration suite spawns `openclaw` from
# PATH, and that copy is deliberately the latest — an upstream release that
# breaks the plugin is the thing this job exists to notice, and a lockfile
# would hide it. So the two can differ by design: pinned for imports, latest
# for the binary under test.
t1=$(date +%s)
log "pnpm add -g openclaw (latest, unpinned)"
pnpm add -g openclaw
log "openclaw install took $(since "$t1")s ($(openclaw --version 2>/dev/null || echo 'version unknown'))"

# cursor-agent unpacks into $HOME/.local (already on PATH). A network hiccup
# does not fail the run here — five of the seven tests stub the binary and would
# still be worth running. The other two need it, and rather than have them skip
# themselves into a permanently green job, `requireIntegrationEnvironment({
# cursorAgent: true })` fails that file at import whenever CI is set and the
# binary is absent. So a failed install still turns the job red; it just does
# it where the reason is legible.
t2=$(date +%s)
log "installing cursor-agent into \$HOME/.local"
if curl -fsS https://cursor.com/install | bash; then
  log "cursor-agent install took $(since "$t2")s ($(cursor-agent --version 2>/dev/null || echo 'version unknown'))"
else
  log "cursor-agent install FAILED after $(since "$t2")s (continuing; five of seven tests stub the binary)"
fi

log "total runtime setup: $(since "$t0")s"
log "exec: $*"
exec "$@"
