#!/bin/sh
# Start the published image with a loopback-only offline simulator configuration.
set -eu
umask 022
cd "$(dirname "$0")/.."
docker compose version >/dev/null
mkdir -p config
if [ ! -f config/config.toml ]; then
    (
        set -C
        sed -e 's/^bind = "127.0.0.1"/bind = "0.0.0.0"/' \
            -e 's/^# allowed_hosts = .*/allowed_hosts = ["127.0.0.1:8787"]/' \
            config.example.toml > config/config.toml
    )
fi
docker compose pull softhead
docker compose up -d softhead
docker compose ps softhead
