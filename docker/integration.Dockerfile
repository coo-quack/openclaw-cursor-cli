# Integration-test image for @coo-quack/openclaw-cursor-cli.
#
# Deliberately does NOT bake in `openclaw` or `cursor-agent`: both are
# installed at container start (see docker/integration-entrypoint.sh) so the
# suite keeps catching upstream breakage instead of pinning a stale copy into
# an image layer.
#
# Node itself is the opposite case, and is pinned to a digest. Even a minor tag
# floats across patch releases, so two runs a week apart could test different
# Nodes and a red run would stop being attributable to the thing the suite
# watches. Renovate keeps the digest current; the tag is kept alongside it for
# readability and has to stay inside openclaw's `>=24.15.0 <25`.
#
# The digest is the multi-arch index, not a single platform: CI is amd64 and
# contributors are often arm64, and both have to resolve.
FROM node:24.18-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

# `curl` is required by the cursor-agent installer; `ca-certificates` by both
# the installer and npm over TLS. Nothing else is added.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The image runs as the base image's existing unprivileged `node` user (uid
# 1000). Root bypasses `chmod 000`, which silently turns 8 of the *unit*
# suite's permission-denied assertions into failures. The integration suite has
# none of those, but this image runs both, and a container that only works as
# root is a trap for whoever picks it up next.
#
# Two things have to be writable by that user for the runtime installs:
#   - a global npm prefix (`npm install -g openclaw` must not need root)
#   - $HOME/.local, where the cursor-agent installer unpacks itself
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/node/.local/bin:$PATH
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV CI=true

# `.npm` is the cache, which npm defaults under $HOME; creating it up front
# keeps the first install from doing it as a side effect.
RUN mkdir -p /home/node/.npm-global/lib /home/node/.local/bin /home/node/.npm /work \
  && chown -R node:node /home/node /work

COPY --chown=node:node docker/integration-entrypoint.sh /usr/local/bin/integration-entrypoint.sh
RUN chmod 0755 /usr/local/bin/integration-entrypoint.sh

USER node
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/integration-entrypoint.sh"]
# What the image is for. The unit suite runs here too — `npm test` as an
# override — which is where the non-root note above earns its keep.
CMD ["npm", "run", "test:integration"]
