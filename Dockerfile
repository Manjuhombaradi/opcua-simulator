# Headless OPC UA Simulator (no GUI) - runs on any Docker host / Linux VM.
#   docker build -t opcua-simulator .
#   docker run -p 4840:4840 -e OPCUA_HOSTNAME=<host-ip-or-name> opcua-simulator
# Clients use the endpoint URLs the server advertises, so publish the same port on both sides
# (-p 4841:4841 -e OPCUA_PORT=4841). With a different host port, advertise the URL clients really use:
#   docker run -p 48400:4840 -e OPCUA_ADVERTISED_URL=opc.tcp://<host-ip-or-name>:48400 opcua-simulator
# Options go after the image name, e.g. `docker run ... opcua-simulator --secure --no-scripts` (see SECURITY.md).
#
# The base image is pinned by digest, so every build of a commit uses the same Node.js and Debian packages.
# Tag: node:22-bookworm-slim (digest of 2026-10-21). Dependabot proposes new digests weekly; rebuild the
# image when Node.js publishes a security release.

# ---- stage 1: install the production dependencies (the build tools stay in this stage)
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Exactly the versions in package-lock.json, no install scripts. Electron and the packaging tools are
# dev dependencies and are not installed.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- stage 2: runtime image
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
LABEL org.opencontainers.image.authors="Manjunagouda Hombaradi <manjuhombaradi@gmail.com>"

# npm, npx, corepack and yarn are not needed to run the simulator: remove them (less to attack, fewer
# scanner findings). Run as the unprivileged "node" user (uid 1000). /data belongs to group 0 and is
# group writable, so random UIDs (OpenShift, `docker run --user`) that run with group 0 can write it too;
# other users have no access.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data && chown node:0 /data && chmod 0770 /data

WORKDIR /app
# OPCUA_IN_CONTAINER: the simulator does not advertise the container's internal IPs and warns
# when neither OPCUA_HOSTNAME nor OPCUA_ADVERTISED_URL is set.
ENV NODE_ENV=production \
    OPCUA_DATA_DIR=/data \
    OPCUA_PORT=4840 \
    OPCUA_HEALTH_FILE=/tmp/opcua-health \
    OPCUA_IN_CONTAINER=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node

EXPOSE 4840
VOLUME ["/data"]
# healthy while the simulator keeps touching its liveness file (no connections to the OPC UA port)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "process.exit(Date.now()-require('fs').statSync(process.env.OPCUA_HEALTH_FILE).mtimeMs<30000?0:1)"

ENTRYPOINT ["node", "src/cli.js"]
