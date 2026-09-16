#!/usr/bin/env bash
# Bring a freshly uploaded build into service. Run on the Oracle box, as a user with
# sudo; the deploy workflow calls it over SSH after rsyncing the built files.
#
#   bash /srv/riderhub/current/deploy/apply.sh
#
# Installs production dependencies, restarts the API, reloads Caddy, and then proves the
# thing actually answers — a deploy that "succeeded" while the service is crash-looping
# is worse than one that failed, because nobody goes looking.
set -euo pipefail

ROOT=/srv/riderhub/current
PORT="$(grep -E '^PORT=' /etc/riderhub/api.env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-8731}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Ownership"
# The upload arrives over rsync as root (it needs sudo to write into /srv). The service
# runs as an unprivileged user and must be able to read every file it was given.
sudo chown -R riderhub:riderhub /srv/riderhub/current

say "Production dependencies"
# --omit=dev: the box never compiles anything, TypeScript is built by the runner.
sudo -u riderhub npm --prefix "$ROOT/backend" ci --omit=dev --no-audit --no-fund

say "Configuration"
# Installed from the repo each time so a change to either is picked up by a deploy
# rather than needing someone to remember.
sudo cp "$ROOT/deploy/riderhub-api.service" /etc/systemd/system/riderhub-api.service
sudo cp "$ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload

say "Restart"
sudo systemctl restart riderhub-api
sudo systemctl enable riderhub-api >/dev/null 2>&1 || true
# validate first: a bad Caddyfile would otherwise take the whole site down on reload.
sudo bash -c 'set -a; . /etc/riderhub/caddy.env; set +a; caddy validate --config /etc/caddy/Caddyfile' >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

say "Health"
for i in $(seq 1 20); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "API is up on 127.0.0.1:$PORT"
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health"; echo
    break
  fi
  [[ $i -eq 20 ]] && {
    echo "API did not come up within 20s. Recent log:" >&2
    sudo journalctl -u riderhub-api -n 40 --no-pager >&2
    exit 1
  }
  sleep 1
done

say "Deployed"
systemctl is-active riderhub-api caddy
