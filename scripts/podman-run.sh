#!/bin/sh
# Run a command in an isolated container, for builds and tests. The internal network has no route to
# the host or the internet.
cd "$(dirname "$0")/.." || exit 1

# Each run gets its own network, so separate sessions can't find each other's services
network=rr-cli-isolated-$$
podman network create --internal --ipv6 "$network" >/dev/null || exit 1
trap 'podman network rm -f "$network" >/dev/null 2>&1' EXIT

podman run --rm -i --network="$network" --memory=4g \
    -v "$PWD:/work/robotraconteur_cli:Z" \
    -v /work/robotraconteur_cli/node_modules \
    -w /work/robotraconteur_cli rr-ts-cli-dev "$@"
