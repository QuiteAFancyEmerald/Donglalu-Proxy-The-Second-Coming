FROM golang:1.25.3-alpine AS relay-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY relay ./relay
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go build -trimpath -ldflags="-s -w" -o /out/dlpcc-relay ./relay

FROM node:22-bookworm-slim AS app-build

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

COPY --from=relay-build /out/dlpcc-relay /tmp/dlpcc-relay
RUN mkdir -p "bin/linux-$(node -p 'process.arch')" \
    && cp /tmp/dlpcc-relay "bin/linux-$(node -p 'process.arch')/dlpcc-relay"

COPY demo/package.json demo/package-lock.json ./demo/
RUN npm ci --prefix demo
COPY demo/ ./demo/
RUN npm run build --prefix demo \
    && npm prune --omit=dev --prefix demo

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=app-build /app/package.json ./package.json
COPY --from=app-build /app/dist ./dist
COPY --from=app-build /app/src/client.js ./src/client.js
COPY --chown=node:node --from=app-build /app/bin ./bin
COPY --from=app-build /app/demo/server.js ./demo/server.js
COPY --from=app-build /app/demo/dist ./demo/dist
COPY --from=app-build /app/demo/node_modules ./demo/node_modules

WORKDIR /app/demo
ENV PORT=8080
EXPOSE 8080/tcp 49152-65535/udp
USER node
CMD ["node", "server.js"]
