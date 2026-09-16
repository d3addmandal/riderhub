#!/usr/bin/env bash
# One-time provisioning of an Oracle Cloud Always Free instance (Ubuntu) for RiderHub.
#
#   curl -fsSL https://raw.githubusercontent.com/d3addmandal/riderhub/main/deploy/setup-oracle.sh | sudo bash -s -- rides.example.com you@example.com
#
# or, from a clone:  sudo bash deploy/setup-oracle.sh rides.example.com you@example.com
#
# Installs Node and Caddy, creates the service account and directories, opens 80/443 in
# the instance firewall, and writes the two environment files. It does NOT put any
# secret in place — it creates the files with placeholders and tells you what to fill in,
# so no credential is ever typed into a command line or left in shell history.
#
# Safe to re-run: every step checks before acting.
set -euo pipefail

DOMAIN="${1:-}"
ACME_EMAIL="${2:-}"
API_PORT="${RIDERHUB_API_PORT:-8731}"

if [[ -z "$DOMAIN" || -z "$ACME_EMAIL" ]]; then
  echo "usage: sudo bash deploy/setup-oracle.sh <domain> <email-for-cert-expiry-warnings>" >&2
  echo "example: sudo bash deploy/setup-oracle.sh rides.example.com dipanjan@example.com" >&2
  exit 2
fi
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 2; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync debian-keyring debian-archive-keyring apt-transport-https

# Ubuntu's own nodejs package lags badly; the backend targets Node 22.
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  say "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

if ! command -v caddy >/dev/null; then
  say "Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
caddy version

say "Service account and directories"
id riderhub &>/dev/null || useradd --system --home /srv/riderhub --shell /usr/sbin/nologin riderhub
install -d -o riderhub -g riderhub -m 755 /srv/riderhub /srv/riderhub/current \
  /srv/riderhub/current/backend /srv/riderhub/current/frontend/dist
install -d -o root -g root -m 750 /etc/riderhub

say "Firewall"
# Oracle has two firewalls and forgetting the second one is the classic lost afternoon:
# the VCN security list (in the web console — open 80 and 443 there yourself) and the
# instance's own iptables, which Oracle images ship locked down. This is the second one.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    echo "opened $port"
  else
    echo "$port already open"
  fi
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null || \
  echo "note: install iptables-persistent to keep these rules across reboots"

say "Configuration files"
if [[ ! -f /etc/riderhub/api.env ]]; then
  cat > /etc/riderhub/api.env <<EOF
# RiderHub API — systemd reads this. Restart after editing:  sudo systemctl restart riderhub-api
#
# Non-standard port, localhost only: Caddy is the sole way in from outside.
PORT=$API_PORT
BIND_HOST=127.0.0.1
# Caddy is exactly one proxy hop, so the client address is the last entry it appends.
# Without this the rate limiter would see Caddy's address and throttle the whole club
# as if it were a single rider.
TRUST_PROXY=1
FRONTEND_URL=https://$DOMAIN

# ---- Firebase Admin (Firebase Console > Project settings > Service accounts) ----
FIREBASE_PROJECT_ID=fly-with-pegasus
FIREBASE_CLIENT_EMAIL=
# Keep the quotes and the literal \\n escapes exactly as they appear in the JSON.
FIREBASE_PRIVATE_KEY=""

# ---- Google Maps ----
# Server key: Routes, Places, Geocoding. Never leaves this machine.
GOOGLE_MAPS_API_KEY=
# Browser key: handed to signed-in riders. Restrict it by HTTP referrer to https://$DOMAIN/*
GOOGLE_MAPS_BROWSER_KEY=
GOOGLE_MAPS_MAP_ID=

# ---- Telegram (optional; SOS alerts) ----
TELEGRAM_BOT_TOKEN=
EOF
  chmod 600 /etc/riderhub/api.env
  echo "created /etc/riderhub/api.env — fill it in"
else
  echo "/etc/riderhub/api.env already exists, left alone"
fi

cat > /etc/riderhub/caddy.env <<EOF
RIDERHUB_DOMAIN=$DOMAIN
RIDERHUB_ACME_EMAIL=$ACME_EMAIL
RIDERHUB_API_PORT=$API_PORT
RIDERHUB_WEB_ROOT=/srv/riderhub/current/frontend/dist
EOF
chmod 644 /etc/riderhub/caddy.env

# Caddy's packaged unit does not read an environment file; this drop-in adds one.
install -d /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/riderhub.conf <<'EOF'
[Service]
EnvironmentFile=/etc/riderhub/caddy.env
EOF

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SELF_DIR/Caddyfile" ]]; then
  cp "$SELF_DIR/Caddyfile" /etc/caddy/Caddyfile
  cp "$SELF_DIR/riderhub-api.service" /etc/systemd/system/riderhub-api.service
  echo "installed Caddyfile and riderhub-api.service"
else
  echo "note: run this from a clone of the repo to install the Caddyfile and unit automatically"
fi

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1 || true

say "Done"
cat <<EOF

Still to do, in this order:

  1. Open ports 80 and 443 in the Oracle VCN security list (web console).
     The iptables half is done; the console half is not, and nothing works without both.

  2. Point DNS at this machine:
         $DOMAIN  A  $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this instance public IP>')
     A free DuckDNS name works if you have no domain.

  3. Fill in /etc/riderhub/api.env  (sudo nano /etc/riderhub/api.env)

  4. Deploy the code — from GitHub: Actions > Deploy to Oracle > Run workflow.

Caddy will request the certificate on its first start once DNS resolves here.
EOF
