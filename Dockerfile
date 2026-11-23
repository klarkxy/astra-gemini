FROM node:26-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system safe.directory '*'

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY sdks ./sdks
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY docker/settings-init.mjs ./docker/settings-init.mjs
COPY docker/projects.default.json ./docker/projects.default.json
COPY docker/verify.mjs ./docker/verify.mjs
COPY LICENSE NOTICE ./

RUN chmod +x ./docker/entrypoint.sh \
    && mkdir -p /data /workspace/demo \
    && chown -R node:node /data /workspace

ENV ASTRA_BRIDGE_ROOT=/data \
    HOST=0.0.0.0 \
    PORT=3939

USER node

EXPOSE 3939

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3939)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
