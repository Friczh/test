# syntax=docker/dockerfile:1

# --- Stage 1: fetch the bgutil-pot release binary -----------------------
# Built on a recent Ubuntu CI runner; needs glibc >= 2.34. The final stage
# below must therefore be Debian bookworm (glibc 2.36) or newer, not Alpine
# (musl) and not Debian bullseye (glibc 2.31 — too old, will crash-loop).
FROM debian:bookworm-slim AS potfetch
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fL -o /tmp/bgutil-pot \
    https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64 \
    && chmod +x /tmp/bgutil-pot

# --- Stage 2: final image -------------------------------------------------
FROM node:20-bookworm-slim AS final

# ca-certificates in the SHIPPED stage, not just the fetch stage above — the
# bgutil-pot binary makes its own HTTPS calls to Google endpoints at runtime.
# curl is NOT needed here — it was only ever used by start.sh's health-check
# loop, which now uses Node's built-in fetch instead (node is already the
# runtime), so it doesn't need to be installed in this stage at all.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# --legacy-peer-deps: prism-media@1.3.5 lists opusscript@^0.0.8 as an
# OPTIONAL peer dependency (peerDependenciesMeta.opusscript.optional:
# true, confirmed in installed prism-media/package.json), but npm's
# ERESOLVE check still hard-fails on version mismatches for optional
# peers regardless -- long-standing npm behavior, not a bug in this
# setup. opusscript@0.1.1 (see buildTranscodedOpusPipeline() in
# demuxPipeline.js) is confirmed working against prism-media's loader
# (which just does a plain `require('opusscript')` + duck-typed API
# check, not a semver check) via a real end-to-end AAC transcode test
# -- so the fix here is telling npm to ignore the stale peer range,
# not downgrading a version we've verified works.
RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps

COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

COPY --from=potfetch /tmp/bgutil-pot /usr/local/bin/bgutil-pot

# Build-time smoke test: catches a glibc/arch mismatch between the CI runner
# that built the release binary and this base image, instead of a silent
# runtime crash-loop after deploy.
RUN /usr/local/bin/bgutil-pot --version

# Same rationale, for the ffmpeg-static binary `npm ci` above just fetched
# via its postinstall script (used only for the SABR non-Opus/AAC
# transcode fallback -- see src/lib/demuxPipeline.js's
# buildTranscodedOpusPipeline()). ffmpeg-static ships a static, self-
# contained Linux x86_64 binary, so this should never actually fail on
# this base image, but it's a one-line check against a silent failure
# mode being deferred to the first AAC-only track someone actually queues.
RUN ffmpeg_bin="$(node -e "console.log(require('ffmpeg-static'))")" && "$ffmpeg_bin" -version

ENV NODE_ENV=production
ENV POT_SERVER_HOST=127.0.0.1
ENV POT_SERVER_PORT=4416
ENV POT_PROVIDER_URL=http://127.0.0.1:4416
# Render's health check needs something listening on $PORT -- Render sets
# this env var itself at deploy time (overriding this default), so this
# ENV only matters for non-Render runs (local Docker, the friend's Debian
# host) where nothing else sets $PORT. See src/lib/health.js.
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["./start.sh"]
