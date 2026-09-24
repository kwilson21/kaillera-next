#!/bin/sh
# Host the public kaillera-next site from this Mac, behind a Cloudflare Tunnel.
#
#   sh deploy/home/install.sh            # first install, or re-run to repair
#   sh deploy/home/install.sh --tokens   # re-enter the tunnel / TURN tokens
#
# Sets up, all under your user (no sudo):
#   ~/kaillera-next-live                         clean checkout of main (not your dev clone)
#   ~/Library/Application Support/kaillera-next/env   secrets, readable by you only
#   ~/Library/LaunchAgents/us.thesuperhuman.kn.*.plist
#       server  the site on 127.0.0.1:27890, restarted if it exits
#       tunnel  cloudflared, connecting that port to Cloudflare
#       update  every 5 min: deploy main if it moved (waits while anyone plays)
#   ~/Library/Logs/kaillera-next/*.log
# Tokens are typed at a hidden prompt and stored only in the env file.
set -eu

REPO_URL=https://github.com/kwilson21/kaillera-next.git
LIVE="$HOME/kaillera-next-live"
CONF="$HOME/Library/Application Support/kaillera-next"
ENV_FILE="$CONF/env"
LOGS="$HOME/Library/Logs/kaillera-next"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM=$(id -u)
PATH_FOR_AGENTS="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$PATH:$PATH_FOR_AGENTS"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "this installer is for macOS"

# ── Tools ─────────────────────────────────────────────────────────────────────
say "Checking tools"
for tool in uv cloudflared; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || die "$tool is missing. Install Homebrew (https://brew.sh), then re-run."
    echo "installing $tool with Homebrew"
    brew install "$tool"
  fi
done
command -v git >/dev/null 2>&1 || die "git is missing (run: xcode-select --install)"
echo "uv, cloudflared, git: ok"

# ── Live checkout ─────────────────────────────────────────────────────────────
say "Live checkout at $LIVE"
if [ ! -d "$LIVE/.git" ]; then
  git clone --quiet "$REPO_URL" "$LIVE"
else
  git -C "$LIVE" fetch --quiet origin main
  git -C "$LIVE" reset --quiet --hard origin/main
fi
git -C "$LIVE" log -1 --format='at %h %s'
(cd "$LIVE/server" && uv sync --frozen --quiet)

# ── Secrets ───────────────────────────────────────────────────────────────────
say "Secrets in $ENV_FILE"
mkdir -p "$CONF" "$LOGS"
chmod 700 "$CONF"
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
put() { # put KEY VALUE: replace or append one line
  grep -v "^$1=" "$ENV_FILE" >"$ENV_FILE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}
ask_secret() { # ask_secret KEY "prompt" required|optional
  printf '%s' "$2"
  stty -echo 2>/dev/null || true
  IFS= read -r val || true
  stty echo 2>/dev/null || true
  printf '\n'
  case "$val" in
    '') [ "$3" = required ] && die "$1 is required" || return 0 ;;
    *[!A-Za-z0-9._=+/-]*) die "$1 has unexpected characters; copy just the token" ;;
  esac
  put "$1" "$val"
}
trap 'stty echo 2>/dev/null || true' EXIT INT

for key in ADMIN_KEY IP_HASH_SALT; do
  [ -n "$(get $key)" ] || put "$key" "$(openssl rand -hex 32)"
done
if [ -z "$(get TUNNEL_TOKEN)" ] || [ "${1:-}" = --tokens ]; then
  echo "Paste the tunnel token (Cloudflare dashboard, see deploy/home/README.md). Input is hidden."
  ask_secret TUNNEL_TOKEN "Tunnel token: " required
  echo "Optional: Cloudflare TURN key id and API token (Enter to skip; players on strict networks need them)."
  ask_secret CF_TURN_KEY_ID "TURN key id: " optional
  ask_secret CF_TURN_API_TOKEN "TURN API token: " optional
fi
echo "stored (values not shown)"

# ── launchd agents ────────────────────────────────────────────────────────────
say "Background services"
mkdir -p "$AGENTS"
chmod +x "$LIVE"/deploy/home/*.sh

agent() { # agent NAME SCRIPT KIND   (KIND: service | every5min)
  label="us.thesuperhuman.kn.$1"
  plist="$AGENTS/$label.plist"
  if [ "$3" = service ]; then
    extra="<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>"
  else
    extra="<key>StartInterval</key><integer>300</integer>"
  fi
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$LIVE/deploy/home/$2</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_FOR_AGENTS</string></dict>
  <key>RunAtLoad</key><true/>
  $extra
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$plist"
  echo "$label loaded"
}
agent server run-server.sh service
agent tunnel run-tunnel.sh service
agent update update.sh every5min

# ── Check ─────────────────────────────────────────────────────────────────────
say "Waiting for the server"
i=0
until curl -fsS --max-time 5 http://127.0.0.1:27890/health >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || die "server didn't come up; see $LOGS/server.log"
  sleep 2
done
git -C "$LIVE" rev-parse HEAD >"$CONF/deployed-rev"
echo "server: ok  (http://localhost:27890/)"
sleep 3
if grep -q "Registered tunnel connection" "$LOGS/tunnel.log" 2>/dev/null; then
  echo "tunnel: connected"
else
  echo "tunnel: not connected yet; check $LOGS/tunnel.log in a minute"
fi

cat <<EOF

Done. The site runs whenever this Mac is on and online, and follows main.
  Logs:       $LOGS/{server,tunnel,update}.log
  Stop:       sh $LIVE/deploy/home/uninstall.sh
  Admin key:  grep ADMIN_KEY "$ENV_FILE"
Keep the Mac plugged in; the services keep it awake while they run.
EOF
