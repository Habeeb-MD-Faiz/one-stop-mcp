# syntax=docker/dockerfile:1
#
# One-Stop MCP gateway image (D21). Two stages: compile TypeScript, then ship
# only the compiled output plus production dependencies. Runs as the non-root
# `node` user; all state lives in the /data volume.
#
#   docker build -t one-stop-mcp .
#   docker build --build-arg EMBEDDINGS=1 -t one-stop-mcp:embeddings .
#
# EMBEDDINGS=1 keeps the optional @huggingface/transformers dependency so the
# dense routing leg can run. The model itself is not baked in: it downloads from
# the Hugging Face hub on first use. Without it, routing is lexical + BM25.
#
# Nothing here is pushed anywhere; see .github/workflows/release.yml.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: full install (dev + optional) so tsc can resolve every import ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled output ----------------------
FROM ${NODE_IMAGE} AS runtime
ARG EMBEDDINGS=0
ENV NODE_ENV=production \
    OSMCP_HOME=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ "$EMBEDDINGS" = "1" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi \
 && npm cache clean --force

# The gateway resolves servers/ and catalog/ one level above dist/, and the demo
# manifest's relative path points into examples/.
COPY --from=build /app/dist ./dist
COPY LICENSE ./
COPY servers ./servers
COPY catalog ./catalog
COPY examples ./examples

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8420

# /healthz is served in both modes. 8420 is the default port (D32); if you
# change http.port, override this with --health-cmd or in compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8420/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Team mode: Streamable HTTP for clients. Needs OSMCP_MASTER_KEY at run time.
# package.json's bin is dist/index.js, which hands argv to the CLI.
CMD ["node", "dist/index.js", "serve", "--http"]
