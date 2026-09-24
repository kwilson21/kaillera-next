#!/bin/sh
# Connect this Mac to the kaillera-next Cloudflare Tunnel. cloudflared dials
# out, so no port is opened on the router or the Mac.
# Started and kept alive by launchd (us.thesuperhuman.kn.tunnel); see README.md.
set -eu

CONF="$HOME/Library/Application Support/kaillera-next"
TUNNEL_TOKEN=$(sed -n 's/^TUNNEL_TOKEN=//p' "$CONF/env")
export TUNNEL_TOKEN # read by cloudflared from the environment, not argv

caffeinate -is -w $$ &
exec cloudflared tunnel --no-autoupdate run
