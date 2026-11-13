#!/bin/sh
# Run from the deployment directory alongside compose.yaml and .env.
set -eu
container=$(docker compose ps -q softhead)
if [ -n "$container" ]; then
  state=$(docker exec "$container" python -c '
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:8787/softhead/debug/live/state",
                             headers={"X-Softhead-Audio": "1"})
with urllib.request.urlopen(req, timeout=3) as response:
    print(json.load(response)["network_enabled"])
')
  if [ "$state" != False ]; then
    echo "软机头仍在联网，跳过本次更新。"
    exit 0
  fi
fi
docker compose pull softhead
docker compose up -d --no-deps softhead
