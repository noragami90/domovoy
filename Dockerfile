# Two targets from one base:
#   app (default) — the engine, for the Raspberry Pi next to CUBE (build for linux/arm64);
#   sim           — the CUBE simulator, for running everything on a Mac.
# Engine data, config.yaml, rules/ and .env live in the /data volume; on first start the
# example config and rules are copied there.
FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Tbilisi
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY rules ./rules
COPY scenes ./scenes
COPY config.example.yaml ./

FROM base AS sim
COPY sim ./sim
ENV SIM_HOST=0.0.0.0 SIM_PORT=8765
EXPOSE 8765
CMD ["node", "--disable-warning=ExperimentalWarning", "sim/server.ts"]

FROM base AS app
ENV DOMOVOY_CONFIG=/data/config.yaml
VOLUME /data
WORKDIR /data
CMD ["node", "--disable-warning=ExperimentalWarning", "--env-file-if-exists=/data/.env", "/app/src/main.ts"]
