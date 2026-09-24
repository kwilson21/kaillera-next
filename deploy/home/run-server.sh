#!/bin/sh
# Run the kaillera-next server for the public site from the live checkout.
# Started and kept alive by launchd (us.thesuperhuman.kn.server); see README.md.
set -eu

CONF="$HOME/Library/Application Support/kaillera-next"
LIVE="$HOME/kaillera-next-live"

# Only the keys the server needs (the tunnel token stays with cloudflared).
for key in ADMIN_KEY IP_HASH_SALT CF_TURN_KEY_ID CF_TURN_API_TOKEN; do
  val=$(sed -n "s/^$key=//p" "$CONF/env" | head -n 1)
  if [ -n "$val" ]; then export "$key=$val"; fi
done

export PORT=27890
export HOST=127.0.0.1 # only cloudflared (same machine) reaches it; nothing on the LAN
export ALLOWED_ORIGIN="https://kaillera-next.thesuperhuman.us,http://localhost:27890"
export TRUSTED_PROXY_IPS=127.0.0.1
export DISABLE_HTTPS=1
# Hard rule: the public site never transfers ROMs between players.
export ROM_SHARING_ENABLED=false

cd "$LIVE/server"
# Keep the Mac awake while the server runs (on power; -w follows this PID,
# which becomes the server after exec).
caffeinate -is -w $$ &
exec uv run --frozen kaillera-server
