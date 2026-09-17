#!/usr/bin/env bash
#
# RiderHub on Oracle Cloud — one command, every time.
#
#   sudo ./run.sh                     provision on the first run, update on every run after
#   sudo ./run.sh --no-pull           build and restart what is already checked out
#   sudo ./run.sh --status            what is running, and recent logs
#   sudo ./run.sh --whoami            this machine's address vs where the domain points
#   sudo ./run.sh --domain=host.name  serve a different hostname
#   sudo ./run.sh --duckdns=<token>   point a DuckDNS name here, and keep it pointed here
#
# First run: installs Node and Caddy, creates the service user, opens the instance
# firewall, writes the configuration files, builds both halves, and starts everything
# under systemd so it survives reboots.
#
# Every run after: pulls from GitHub, rebuilds, restarts, and refuses to report success
# until the API actually answers.
#
# Nothing here needs editing. The only file you fill in by hand is /etc/riderhub/api.env,
# and the first run tells you when.
set -euo pipefail

APP_HOME=/srv/riderhub
APP_DIR="$APP_HOME/app"
ETC=/etc/riderhub
API_PORT_DEFAULT=8731

PULL=1
DUCKDNS_TOKEN=""
NEW_DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --duckdns=*) DUCKDNS_TOKEN="${arg#*=}" ;;
    --domain=*) NEW_DOMAIN="${arg#*=}" ;;
    --whoami)
      # What the outside world thinks this machine is, versus where the name points.
      # A mismatch is the whole story behind "certificate has expired" and a stranger's
      # web page on your domain: DuckDNS records the IP of whatever network you were
      # browsing from, which is rarely the server.
      mine=$(curl -fsS --max-time 8 https://api.ipify.org || echo '?')
      echo "this machine : $mine"
      if [[ -f /etc/riderhub/caddy.env ]]; then
        . /etc/riderhub/caddy.env
        theirs=$(getent hosts "$RIDERHUB_DOMAIN" | awk '{print $1}' | head -1)
        echo "$RIDERHUB_DOMAIN resolves to : ${theirs:-<nothing>}"
        [[ "$mine" == "$theirs" ]] && echo "match — DNS is correct" \
          || echo "MISMATCH — the domain points somewhere else, so no certificate can be issued"
      fi
      exit 0 ;;
    --status)  systemctl status riderhub-api caddy --no-pager -l | head -40
               echo; journalctl -u riderhub-api -n 25 --no-pager; exit 0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run it with sudo:  sudo ./run.sh"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The systemd unit is locked down with ProtectHome, so the code cannot live in /home.
# If this was copied somewhere else, mirror it into place and carry on from there —
# the copy you started from is left alone.
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  say "Moving the code to $APP_DIR"
  install -d -m 755 "$APP_HOME"
  # .env is deliberately left behind: the app directory is world-readable, and the
  # service reads its secrets from /etc/riderhub/api.env (0600) instead. But remember
  # where it was, so those values can still be copied into that file below — otherwise
  # relocating silently loses the one thing worth carrying over.
  [[ -f "$SRC_DIR/backend/.env" ]] && export RIDERHUB_SEED_ENV="$SRC_DIR/backend/.env"
  rsync -a --delete \
    --exclude .git --exclude node_modules --exclude dist --exclude '.env' \
    "$SRC_DIR"/ "$APP_DIR"/
  # Keep git history if there is any, so later runs can pull.
  [[ -d "$SRC_DIR/.git" && ! -d "$APP_DIR/.git" ]] && cp -a "$SRC_DIR/.git" "$APP_DIR/.git"
  echo "From now on run:  sudo $APP_DIR/run.sh"
  exec "$APP_DIR/run.sh" "$@"
fi

FIRST_RUN=0
DOMAIN_CHANGED=0
[[ -f "$ETC/caddy.env" ]] || FIRST_RUN=1

# ─────────────────────────────── first run only ───────────────────────────────
if [[ $FIRST_RUN -eq 1 ]]; then
  say "First run — setting the machine up"

  DOMAIN="${NEW_DOMAIN:-${RIDERHUB_DOMAIN:-}}"
  ACME_EMAIL="${RIDERHUB_ACME_EMAIL:-}"
  if [[ -z "$DOMAIN" ]]; then
    read -rp "Hostname the club will use (e.g. rides.example.com, or yourclub.duckdns.org): " DOMAIN
  fi
  if [[ -z "$ACME_EMAIL" ]]; then
    read -rp "Email for certificate expiry warnings: " ACME_EMAIL
  fi
  [[ -n "$DOMAIN" && -n "$ACME_EMAIL" ]] || die "Both are required."

  say "Packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg rsync git \
    debian-keyring debian-archive-keyring apt-transport-https

  # Ubuntu's own nodejs package lags well behind; the backend targets Node 22.
  if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
    say "Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs
  fi

  if ! command -v caddy >/dev/null; then
    say "Caddy"
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  fi
  echo "node $(node -v), $(caddy version | head -1)"

  say "Service user"
  id riderhub &>/dev/null || useradd --system --home "$APP_HOME" --shell /usr/sbin/nologin riderhub
  install -d -o root -g root -m 750 "$ETC"

  # A Vite build wants roughly a gigabyte. The smallest Always Free shapes have exactly
  # that and no swap, so the build gets shot by the OOM killer with no useful message.
  RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
  if (( RAM_MB < 2048 && SWAP_MB < 512 )); then
    say "Swap (${RAM_MB} MB of RAM, no swap — a build would be killed)"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  say "Firewall"
  # Oracle has two firewalls. This is the instance's own iptables; ports 80 and 443 must
  # ALSO be opened in the VCN security list in the web console, and forgetting that half
  # is the single most common reason this setup appears not to work.
  for port in 80 443; do
    if iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
      echo "$port already open"
    else
      iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
      echo "opened $port"
    fi
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 \
    || { apt-get install -y -qq iptables-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1; } \
    || warn "install iptables-persistent to keep these rules across reboots"

  say "Configuration"
  cat > "$ETC/caddy.env" <<EOF
RIDERHUB_DOMAIN=$DOMAIN
RIDERHUB_ACME_EMAIL=$ACME_EMAIL
RIDERHUB_API_PORT=$API_PORT_DEFAULT
RIDERHUB_WEB_ROOT=$APP_DIR/frontend/dist
EOF
  chmod 644 "$ETC/caddy.env"

  if [[ ! -f "$ETC/api.env" ]]; then
    # If the repo was copied up with a working backend/.env, reuse those values rather
    # than making someone retype keys they already have. Otherwise leave blanks.
    SEED=""
    for candidate in "${RIDERHUB_SEED_ENV:-}" "$SRC_DIR/backend/.env" "$APP_DIR/backend/.env"; do
      [[ -n "$candidate" && -f "$candidate" ]] && { SEED="$candidate"; break; }
    done
    {
      echo "# RiderHub API. Restart after editing:  sudo systemctl restart riderhub-api"
      echo "PORT=$API_PORT_DEFAULT"
      echo "BIND_HOST=127.0.0.1"
      echo "TRUST_PROXY=1"
      echo "FRONTEND_URL=https://$DOMAIN"
      echo
      if [[ -n "$SEED" ]]; then
        grep -E '^(FIREBASE_|GOOGLE_|TELEGRAM_)' "$SEED" || true
      else
        cat <<'BLANK'
FIREBASE_PROJECT_ID=fly-with-pegasus
FIREBASE_CLIENT_EMAIL=
# Keep the quotes and the literal \n escapes exactly as they are in the JSON.
FIREBASE_PRIVATE_KEY=""
GOOGLE_MAPS_API_KEY=
GOOGLE_MAPS_BROWSER_KEY=
GOOGLE_MAPS_MAP_ID=
TELEGRAM_BOT_TOKEN=
BLANK
      fi
    } > "$ETC/api.env"
    chmod 600 "$ETC/api.env"
    [[ -n "$SEED" ]] && echo "seeded $ETC/api.env from $SEED" || echo "created $ETC/api.env (blank — fill it in)"
  fi
fi

# Changing the hostname touches configuration only. The browser bundle is not involved:
# it calls /api on whatever origin it was opened from, so there is nothing to rebuild and
# no stale address baked into a build somewhere.
set_env_var() {
  local file=$1 key=$2 val=$3
  if grep -qE "^$key=" "$file" 2>/dev/null; then
    sed -i -E "s|^$key=.*|$key=$val|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

if [[ -n "$NEW_DOMAIN" && $FIRST_RUN -eq 0 ]]; then
  [[ "$NEW_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
    || die "\"$NEW_DOMAIN\" is not a hostname. Give the bare name, e.g. --domain=rides.example.com (no https://, no trailing slash)."
  OLD_DOMAIN=$(grep -E '^RIDERHUB_DOMAIN=' "$ETC/caddy.env" | cut -d= -f2-)
  say "Changing the hostname: $OLD_DOMAIN → $NEW_DOMAIN"
  set_env_var "$ETC/caddy.env" RIDERHUB_DOMAIN "$NEW_DOMAIN"
  set_env_var "$ETC/api.env"   FRONTEND_URL    "https://$NEW_DOMAIN"
  # Keep the DuckDNS updater in step, or it would keep refreshing the old name.
  if [[ -f "$ETC/duckdns.env" ]]; then
    if [[ "$NEW_DOMAIN" == *.duckdns.org ]]; then
      set_env_var "$ETC/duckdns.env" RIDERHUB_DUCKDNS_SUB "${NEW_DOMAIN%%.duckdns.org}"
    else
      systemctl disable --now riderhub-duckdns.timer >/dev/null 2>&1 || true
      warn "The new name is not a DuckDNS one, so the DuckDNS updater has been switched off."
    fi
  fi
  DOMAIN_CHANGED=1
fi

# ─────────────────────────── every run, including the first ───────────────────────────
source "$ETC/caddy.env"

# Bash reads a script in chunks as it executes, by byte offset. Pulling a new version of
# this very file mid-run can therefore jump execution into the middle of a line. Note
# what it looked like before the pull so we can restart cleanly if it changed.
SELF_BEFORE=$(sha256sum "$0" | cut -d' ' -f1)

if [[ $PULL -eq 1 && -d "$APP_DIR/.git" ]]; then
  say "Pulling from GitHub"

  # Git refuses to operate on a repository owned by somebody else — a good default
  # against a planted repo in a shared directory. Here it is expected: the tree belongs
  # to the service account and this script runs as root. Declare this one path safe.
  git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR" \
    || git config --global --add safe.directory "$APP_DIR"

  if ! PULL_OUT=$(git -C "$APP_DIR" pull --ff-only 2>&1); then
    echo "$PULL_OUT"
    # Say what git actually said, then what to do about that specific thing. Guessing a
    # single cause here once sent someone hunting for a credentials problem when the
    # repository was public and git was complaining about file ownership.
    case "$PULL_OUT" in
      *"could not read Username"*|*"Authentication failed"*|*"Permission denied (publickey)"*|*"access rights"*|*"Repository not found"*)
        die "GitHub would not let this machine read the repository.

If it is private, give the box its own read-only key:

  sudo -u riderhub ssh-keygen -t ed25519 -N '' -f $APP_HOME/.ssh/id_ed25519
  sudo cat $APP_HOME/.ssh/id_ed25519.pub

Add it at GitHub → repository → Settings → Deploy keys, then switch the remote:

  sudo git -C $APP_DIR remote set-url origin git@github.com:d3addmandal/riderhub.git

If it is public, check the remote URL is right:  git -C $APP_DIR remote -v" ;;
      *"diverged"*|*"non-fast-forward"*|*"would be overwritten"*|*"local changes"*)
        die "This checkout has changes that are not on GitHub, so a fast-forward is impossible.

  sudo git -C $APP_DIR status          # see what differs
  sudo git -C $APP_DIR reset --hard origin/main   # discard them and match GitHub

The second command throws away local edits — only run it once you have looked." ;;
      *)
        die "git pull failed; the message above is git's own.
Re-run with --no-pull to build and deploy what is already checked out." ;;
    esac
  fi
  echo "$PULL_OUT"
elif [[ $PULL -eq 1 ]]; then
  warn "Not a git checkout — nothing to pull. Copy the files up again, or clone instead."
fi

if [[ "$(sha256sum "$0" | cut -d' ' -f1)" != "$SELF_BEFORE" ]]; then
  say "This script changed in that pull — restarting with the new version"
  exec "$APP_DIR/run.sh" --no-pull "$@"
fi

# ── The service reads its configuration from one file, and only one ──────────────────
#
# systemd's EnvironmentFile puts every line of /etc/riderhub/api.env into the process
# environment, blanks included — and dotenv will not overwrite a variable that already
# exists. So a value left empty there is not a gap that backend/.env can fill in: it
# actively wins, and the app starts, throws, and is restarted by systemd for ever.
# Check before building, so the answer arrives in seconds rather than after a crash loop.
say "Configuration"
# Last assignment wins, matching how systemd reads the file. Surrounding quotes and
# stray whitespace come off; anything inside the value is left exactly as it is.
value_of() {
  grep -E "^$1=" "$ETC/api.env" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -E 's/\r$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'
}
REQUIRED=(FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY)
missing=()
for k in "${REQUIRED[@]}"; do [[ -n "$(value_of "$k")" ]] || missing+=("$k"); done

# A backend/.env sitting on the box is ignored by the service, which is surprising
# enough that leaving it silent is unkind. If it has what is missing, take it.
if (( ${#missing[@]} )); then
  for candidate in "${RIDERHUB_SEED_ENV:-}" "$APP_DIR/backend/.env"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    filled=()
    for k in "${missing[@]}"; do
      line=$(grep -E "^$k=" "$candidate" | tail -1 || true)
      [[ -n "$line" && -n "${line#*=}" ]] || continue
      # Appended, not edited in place: with duplicate keys systemd takes the last one,
      # so this overrides the blank above it without rewriting anyone's file.
      printf '%s\n' "$line" >> "$ETC/api.env"
      filled+=("$k")
    done
    if (( ${#filled[@]} )); then
      echo "took ${filled[*]} from $candidate"
      warn "$candidate is not read by the service — /etc/riderhub/api.env is. Values copied across."
      missing=()
      for k in "${REQUIRED[@]}"; do [[ -n "$(value_of "$k")" ]] || missing+=("$k"); done
      break
    fi
  done
fi

if (( ${#missing[@]} )); then
  die "These are empty in $ETC/api.env, and the API cannot start without them:

  ${missing[*]}

  sudo nano $ETC/api.env

FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY come from Firebase Console →
Project settings → Service accounts → Generate new private key. Paste the private key
on one line, keeping its surrounding quotes and its literal \\n escapes.

Putting them in backend/.env instead will not work: systemd sets these variables from
$ETC/api.env before the app runs, and an empty value there beats anything dotenv finds."
fi
for k in GOOGLE_MAPS_API_KEY GOOGLE_MAPS_BROWSER_KEY; do
  [[ -n "$(value_of "$k")" ]] || warn "$k is empty — the app will run, but $([[ $k == *BROWSER* ]] && echo 'the map will not load' || echo 'routing and place search fall back to free alternatives')."
done
chmod 600 "$ETC/api.env"
echo "required values present"

say "Building"
# devDependencies are needed here: the box compiles TypeScript and runs Vite itself.
npm --prefix "$APP_DIR/backend"  ci --no-audit --no-fund
npm --prefix "$APP_DIR/frontend" ci --no-audit --no-fund
npm --prefix "$APP_DIR/backend"  run build
npm --prefix "$APP_DIR/frontend" run build

say "Checks"
# The same guards the repo runs anywhere else: no server secret in the browser bundle,
# the PWA still installable, and Caddy configured to serve what the app expects.
node "$APP_DIR/tests/phase31.mjs" "$APP_DIR"
node "$APP_DIR/tests/phase36.mjs" "$APP_DIR/frontend/dist"
( cd "$APP_DIR" && node tests/phase40.mjs )

say "Installing services"
sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/deploy/riderhub-api.service" > /etc/systemd/system/riderhub-api.service
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/caddy.env\n' "$ETC" > /etc/systemd/system/caddy.service.d/riderhub.conf
chown -R riderhub:riderhub "$APP_HOME"
systemctl daemon-reload

# DuckDNS, if asked for. Oracle hands out ephemeral public addresses that change when an
# instance is stopped and started, and the record has to be set from the server itself —
# setting it from a laptop points the name at your office or home connection, which is
# how a stranger's web server ends up answering for your domain.
if [[ -n "$DUCKDNS_TOKEN" ]]; then
  say "DuckDNS"
  SUB="${RIDERHUB_DOMAIN%%.duckdns.org}"
  [[ "$SUB" != "$RIDERHUB_DOMAIN" ]] || die "--duckdns only applies to a *.duckdns.org name; yours is $RIDERHUB_DOMAIN"
  printf 'RIDERHUB_DUCKDNS_SUB=%s\nRIDERHUB_DUCKDNS_TOKEN=%s\n' "$SUB" "$DUCKDNS_TOKEN" > "$ETC/duckdns.env"
  chmod 600 "$ETC/duckdns.env"
  cat > /usr/local/bin/riderhub-duckdns <<'DUCK'
#!/usr/bin/env bash
# Point the DuckDNS name at whatever address this machine currently has. No ip= argument:
# DuckDNS then uses the source address of this request, which is the server's own.
set -euo pipefail
. /etc/riderhub/duckdns.env
out=$(curl -fsS --max-time 20 \
  "https://www.duckdns.org/update?domains=${RIDERHUB_DUCKDNS_SUB}&token=${RIDERHUB_DUCKDNS_TOKEN}&ip=")
[[ "$out" == OK ]] || { echo "DuckDNS refused the update: $out" >&2; exit 1; }
echo "DuckDNS updated"
DUCK
  chmod 755 /usr/local/bin/riderhub-duckdns
  cat > /etc/systemd/system/riderhub-duckdns.service <<'DUCKSVC'
[Unit]
Description=Point the DuckDNS name at this machine
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/riderhub-duckdns
DUCKSVC
  cat > /etc/systemd/system/riderhub-duckdns.timer <<'DUCKTIMER'
[Unit]
Description=Keep the DuckDNS name pointed at this machine
[Timer]
OnBootSec=30s
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
DUCKTIMER
  systemctl daemon-reload
  systemctl enable --now riderhub-duckdns.timer >/dev/null
  /usr/local/bin/riderhub-duckdns
fi

say "Starting"
# Validate before reloading: a bad Caddyfile would otherwise take the site down.
( set -a; source "$ETC/caddy.env"; set +a; caddy validate --config /etc/caddy/Caddyfile ) >/dev/null \
  || die "The Caddyfile is not valid — nothing was reloaded, the site is still up."
systemctl enable riderhub-api >/dev/null 2>&1 || true
systemctl restart riderhub-api
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Health"
PORT="${RIDERHUB_API_PORT:-$API_PORT_DEFAULT}"
for i in $(seq 1 25); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$PORT/health"; echo
    break
  fi
  if (( i == 25 )); then
    echo "The API did not come up. Last 40 log lines:" >&2
    journalctl -u riderhub-api -n 40 --no-pager >&2
    die "Deploy failed. Most likely /etc/riderhub/api.env is missing the Firebase credentials."
  fi
  sleep 1
done

printf '\n\033[32m✔ RiderHub is running\033[0m\n'
echo "   https://$RIDERHUB_DOMAIN"
echo "   API on 127.0.0.1:$PORT, reachable only through Caddy"

if [[ $DOMAIN_CHANGED -eq 1 ]]; then
  cat <<EOF

The hostname changed, so three things outside this machine need to agree with it.
Until they do the site will load but sign-in and the map will fail, with nothing
useful in the browser console:

  1. DNS — $RIDERHUB_DOMAIN must resolve here. Check with:
         sudo $APP_DIR/run.sh --whoami
     For a DuckDNS name, point it from this machine:
         sudo $APP_DIR/run.sh --duckdns=<token>

  2. Firebase Console → Authentication → Settings → Authorized domains
         add   $RIDERHUB_DOMAIN
     (and remove the old one once nobody is using it)

  3. Google Cloud → Credentials → browser Maps key → Website restrictions
         add   https://$RIDERHUB_DOMAIN/*

Caddy requests a certificate for the new name as soon as DNS resolves here; watch it:
  journalctl -u caddy -f
EOF
fi

if [[ $FIRST_RUN -eq 1 ]]; then
  cat <<EOF

Still to do, once each:

  1. Oracle console → Networking → VCN → Security Lists → add ingress for TCP 80 and 443.
     The iptables half is done; without the console half nothing can reach this machine.

  2. DNS:  $RIDERHUB_DOMAIN  A  $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this instance public IP>')
     Caddy cannot get a certificate until that resolves here.

  3. Check $ETC/api.env has the Firebase and Google Maps values, then
     sudo systemctl restart riderhub-api

  4. Firebase Console → Authentication → Settings → Authorized domains → add
     $RIDERHUB_DOMAIN   (sign-in is refused from anywhere not listed)

  5. Google Cloud → Credentials → browser Maps key → Website restrictions → add
     https://$RIDERHUB_DOMAIN/*   (otherwise the map silently fails to load)

From then on, to deploy whatever has been pushed to GitHub:

  sudo $APP_DIR/run.sh
EOF
fi
