#!/bin/sh
set -e

DATA=/data

# SDKs are resolved from <bridgeRoot>/sdks; bridgeRoot is the /data volume.
mkdir -p "$DATA/sdks/projects"
ln -sfn /app/sdks/global "$DATA/sdks/global"

gen_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

umask 077

if [ -z "$ASTRA_TOKEN" ]; then
  [ -f "$DATA/token.txt" ] || gen_hex > "$DATA/token.txt"
  ASTRA_TOKEN=$(cat "$DATA/token.txt")
fi
export ASTRA_TOKEN

if [ -z "$ASTRA_JOIN_TOKEN" ]; then
  [ -f "$DATA/join-token.txt" ] || gen_hex > "$DATA/join-token.txt"
  ASTRA_JOIN_TOKEN=$(cat "$DATA/join-token.txt")
fi
export ASTRA_JOIN_TOKEN

if [ -z "$ASTRA_ADMIN_KEY" ]; then
  [ -f "$DATA/admin-key.txt" ] || gen_hex > "$DATA/admin-key.txt"
  ASTRA_ADMIN_KEY=$(cat "$DATA/admin-key.txt")
fi
export ASTRA_ADMIN_KEY

if [ ! -f "$DATA/projects.json" ]; then
  cp /app/docker/projects.default.json "$DATA/projects.json"
fi

node /app/docker/settings-init.mjs

exec node /app/src/server.mjs
