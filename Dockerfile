# Development and test image for robotraconteur_cli.
# Builds on rr-ts-mcp-dev (Node.js, Python Robot Raconteur, and Reynard), from robotraconteur_mcp:
#   podman build -t rr-ts-cli-dev .
# robotraconteur and robotraconteur-node come from npm.
# Builds and tests run on an isolated network. See scripts/podman-run.sh.
FROM localhost/rr-ts-mcp-dev

WORKDIR /work/robotraconteur_cli
COPY package.json package-lock.json ./
# The sources are mounted later, so prepare, which builds them, is skipped here
RUN npm ci --no-audit --no-fund --ignore-scripts
