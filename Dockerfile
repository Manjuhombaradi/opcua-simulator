# Headless OPC UA Simulator (no GUI) - runs on any Docker host / Linux VM.
#   docker build -t opcua-simulator .
#   docker run -p 4840:4840 -e OPCUA_HOSTNAME=<host-ip-or-name> opcua-simulator
# Clients use the endpoint URLs the server advertises, so publish the same port on both sides
# (-p 4841:4841 -e OPCUA_PORT=4841). With a different host port, advertise the URL clients really use:
#   docker run -p 48400:4840 -e OPCUA_ADVERTISED_URL=opc.tcp://<host-ip-or-name>:48400 opcua-simulator
FROM node:22-bookworm-slim

WORKDIR /app
# OPCUA_IN_CONTAINER: the simulator does not advertise the container's internal IPs and warns
# when neither OPCUA_HOSTNAME nor OPCUA_ADVERTISED_URL is set.
ENV NODE_ENV=production \
    OPCUA_DATA_DIR=/data \
    OPCUA_PORT=4840 \
    OPCUA_HEALTH_FILE=/tmp/opcua-health \
    OPCUA_IN_CONTAINER=1

COPY package.json package-lock.json ./
# Electron and the packaging tools are dev dependencies and are not installed here.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY src ./src

# Run as the unprivileged "node" user (uid 1000). /data belongs to group 0 and is group writable, so
# random UIDs (OpenShift, `docker run --user`) that run with group 0 can write it too.
RUN mkdir -p /data && chown node:0 /data && chmod g+rwX /data
USER node

EXPOSE 4840
VOLUME ["/data"]
# healthy while the simulator keeps touching its liveness file (no connections to the OPC UA port)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "process.exit(Date.now()-require('fs').statSync(process.env.OPCUA_HEALTH_FILE).mtimeMs<30000?0:1)"

ENTRYPOINT ["node", "src/cli.js"]
