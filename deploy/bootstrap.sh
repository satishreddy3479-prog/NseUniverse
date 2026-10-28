#!/usr/bin/env bash
# One-time (and safely repeatable) server setup for NSE Universe on a small Ubuntu/Debian VPS.
#
#   sudo bash bootstrap.sh nseuniverse.duckdns.org
#
# What it does: 1 GB swap file, memory/disk tuning, a locked-down service user, Python + Node,
# the app deployed from GitHub, HTTPS with a login in front (Caddy), nightly SQLite backups,
# storage monitoring and a timer that deploys new GitHub commits by itself.
#
# What it never does: delete data, touch other services (for example an existing nse-tradingdesk),
# change SSH or firewall configuration (it only ADDS allow rules for 80/443 if ufw is already active),
# or read/print your broker credentials (you fill /etc/nse-universe/backend.env yourself).
set -Eeuo pipefail

DOMAIN=${1:-nseuniverse.duckdns.org}
REPO_URL=${NSE_REPO_URL:-https://github.com/satishreddy3479-prog/NseUniverse.git}
BRANCH=${NSE_BRANCH:-main}
ROOT=/opt/nse-universe
APP_USER=nseuniverse
SWAP_FILE=/swapfile-nse
SWAP_MB=1024

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash bootstrap.sh)"
command -v apt-get >/dev/null || die "this script supports Ubuntu/Debian (apt) only"
[ -t 0 ] || die "run it from a terminal (download the file, then 'sudo bash bootstrap.sh'); it asks for a login password"

say "Inspecting this server"
. /etc/os-release; echo "OS: $PRETTY_NAME"
free -m | awk 'NR<=3'
df -h / | awk 'NR<=2'
echo "Other project services found (left untouched):"
systemctl list-units --type=service --no-legend 2>/dev/null | grep -E 'nse-|swing|trading' | grep -v 'nse-universe' || echo "  none"
avail_mb=$(df -Pm / | awk 'NR==2{print $4}')
[ "$avail_mb" -ge 4000 ] || die "only ${avail_mb} MB free on /; need at least 4000 MB"
for p in 80 443; do
  who=$(ss -ltnpH "sport = :$p" 2>/dev/null | grep -v caddy || true)
  [ -z "$who" ] || die "port $p is already used by another program:\n$who\nStop or move it first; nothing was changed."
done
if ss -ltnH "sport = :8010" 2>/dev/null | grep -q .; then die "port 8010 is in use; nothing was changed"; fi

say "Swap (extra virtual memory on the SSD) and kernel tuning"
current_swap_mb=$(free -m | awk '/Swap:/{print $2}')
if [ "$current_swap_mb" -ge 900 ]; then
  echo "swap already ${current_swap_mb} MB; not adding more"
elif swapon --show=NAME --noheadings | grep -q "$SWAP_FILE"; then
  echo "$SWAP_FILE already active"
else
  if [ ! -f "$SWAP_FILE" ]; then
    fallocate -l "${SWAP_MB}M" "$SWAP_FILE" 2>/dev/null || dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_MB" status=none
    chmod 600 "$SWAP_FILE"; mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
  grep -q "$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw,pri=10 0 0" >> /etc/fstab
  echo "added ${SWAP_MB} MB swap"
fi
cat > /etc/sysctl.d/99-nse-universe.conf <<'SYS'
# SSD-backed swap is a safety net, not working memory: prefer RAM, keep the file cache modest
vm.swappiness=20
vm.vfs_cache_pressure=80
SYS
sysctl -p /etc/sysctl.d/99-nse-universe.conf >/dev/null
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/nse-universe.conf
systemctl restart systemd-journald

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates nano python3 python3-venv python3-pip sqlite3 xz-utils \
  debian-keyring debian-archive-keyring apt-transport-https gpg util-linux >/dev/null
find_python() { for c in python3.13 python3.12 python3.11 python3; do
  command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' && { echo "$c"; return 0; }
done; return 1; }
if ! find_python >/dev/null; then
  [ "${ID:-}" = ubuntu ] || die "Python 3.11+ is required and this is not Ubuntu; install it and rerun"
  say "Python 3.12 (added next to the system Python 3.10; the system Python is not changed)"
  apt-get install -y -qq software-properties-common >/dev/null
  add-apt-repository -y ppa:deadsnakes/ppa >/dev/null
  apt-get update -qq
  apt-get install -y -qq python3.12 python3.12-venv python3.12-dev >/dev/null
fi
PY=$(find_python) || die "no Python 3.11+ available"
echo "using $PY ($($PY --version))"
echo "$PY" > /etc/nse-universe-python

say "Node.js (official tarball, checksum verified)"
if [ ! -x /opt/node/bin/node ]; then
  base=https://nodejs.org/dist/latest-v22.x
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep 'linux-x64.tar.xz' "$tmp/SHASUMS256.txt" | awk '{print $2}')
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "Node download failed its checksum"
  mkdir -p /opt/node && tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
/opt/node/bin/node --version

say "Service user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nse-universe/home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$ROOT" /var/lib/nse-universe/data /var/lib/nse-universe/home /var/log/nse-universe /var/backups/nse-universe /etc/nse-universe
chown -R "$APP_USER:$APP_USER" "$ROOT" /var/lib/nse-universe /var/log/nse-universe
chmod 750 /var/lib/nse-universe /var/backups/nse-universe

say "Broker settings file (you fill this in; I never see it)"
ENV_FILE=/etc/nse-universe/backend.env
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENVF
# NSE Universe settings on this server. Edit with: sudo nano $ENV_FILE
# then: sudo systemctl restart nse-universe
KOTAK_CONSUMER_KEY=
KOTAK_MOBILE_NUMBER=
KOTAK_UCC=
KOTAK_MPIN=
KOTAK_TOTP_SECRET=
ALLOWED_ORIGINS=https://$DOMAIN
UNDERLYING=NIFTY
SAMPLER_ENABLED=true
SAMPLER_INTERVAL_SECONDS=60
SAMPLER_MIN_FREE_GB=2
HISTORY_AUTOFETCH=true
FLOWS_AUTOFETCH=true
FLOWS_HISTORY_DAYS=10
LOG_LEVEL=INFO
ENVF
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  echo "created $ENV_FILE (credential fields are empty)"
else
  echo "$ENV_FILE already exists; not changed"
fi

say "Broker credentials"
missing_keys() {
  for k in KOTAK_CONSUMER_KEY KOTAK_MOBILE_NUMBER KOTAK_UCC KOTAK_MPIN KOTAK_TOTP_SECRET; do
    v=$(grep -E "^$k=" "$ENV_FILE" | head -n1 | cut -d= -f2-)
    [ -n "$v" ] || return 0
  done
  return 1
}
while missing_keys; do
  echo "The app cannot start until the five KOTAK_* values are filled in $ENV_FILE."
  echo "An editor opens next: type each value after the = sign, save with Ctrl+O Enter, exit with Ctrl+X."
  read -r -p "Press Enter to open the editor (Ctrl+C to stop; running this script again later is safe) " _
  nano "$ENV_FILE"
done
echo "all five KOTAK_* values are present (not shown)"

say "Login for the website (Caddy basic auth)"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  systemctl stop caddy || true   # not started until the login exists
fi
if [ ! -s /etc/nse-universe/caddy-users ]; then
  read -r -p "Choose a website username: " web_user
  [ -n "$web_user" ] || die "username cannot be empty"
  read -r -s -p "Choose a website password (min 12 characters, typed here only): " web_pw; echo
  [ "${#web_pw}" -ge 12 ] || die "password too short (minimum 12 characters)"
  hash=$(caddy hash-password --plaintext "$web_pw")
  unset web_pw
  umask 077
  printf '%s %s\n' "$web_user" "$hash" > /etc/nse-universe/caddy-users
  chown caddy:caddy /etc/nse-universe/caddy-users 2>/dev/null || true
else
  echo "login already configured; not changed"
fi

say "Installing the deploy tools"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$ROOT/repo.bootstrap" >/dev/null 2>&1 || die "cannot clone $REPO_URL"
src="$ROOT/repo.bootstrap/deploy"
install -m 755 "$src/update.sh" /usr/local/sbin/nse-universe-update
install -m 755 "$src/backup.sh" /usr/local/sbin/nse-universe-backup
install -m 755 "$src/monitor.sh" /usr/local/sbin/nse-universe-monitor
install -m 644 "$src"/systemd/*.service "$src"/systemd/*.timer /etc/systemd/system/
install -m 644 "$src/logrotate-nse-universe" /etc/logrotate.d/nse-universe
mkdir -p /etc/caddy /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
sed "s/__DOMAIN__/$DOMAIN/" "$src/Caddyfile.template" > /etc/caddy/Caddyfile
rm -rf "$ROOT/repo.bootstrap"
systemctl daemon-reload

say "First deployment from GitHub (installs Python/Node packages and builds the site; several minutes)"
NSE_REPO_URL="$REPO_URL" NSE_BRANCH="$BRANCH" NSE_MIN_FREE_MB=1500 /usr/local/sbin/nse-universe-update || {
  echo; echo "The first deployment failed. Details: journalctl -u nse-universe -n 80 ; the update log is printed above."; exit 1; }
systemctl enable --now nse-universe.service
systemctl enable --now nse-universe-update.timer nse-universe-backup.timer nse-universe-monitor.timer

say "Firewall (additive only)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "ufw: allowed 80 and 443 (nothing else changed)"
else
  echo "ufw is not active; firewall left as it is (make sure ports 80 and 443 are reachable from the internet)"
fi

say "Public address"
server_ip=$(curl -fsS --max-time 8 https://api.ipify.org || echo unknown)
dns_ip=$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)
echo "this server: $server_ip    $DOMAIN points to: ${dns_ip:-nothing yet}"
if [ "$server_ip" != "$dns_ip" ]; then
  echo "DuckDNS does not point here yet. Open https://www.duckdns.org, sign in, add the domain, set its current ip to $server_ip and press 'update'. Caddy will fetch the HTTPS certificate by itself once it does."
fi
systemctl enable --now caddy
sleep 3

say "Result"
systemctl --no-pager --lines=0 status nse-universe caddy | grep -E 'Active:|Loaded:' || true
curl -fsS http://127.0.0.1:8010/api/health && echo
cat <<DONE

Next step: open https://$DOMAIN and sign in with the website login you just chose.
  (To change broker settings later: sudo nano /etc/nse-universe/backend.env ; sudo systemctl restart nse-universe)
  Logs:  journalctl -u nse-universe -f      Updates: journalctl -u nse-universe-update -n 30
  Health report: journalctl -u nse-universe-monitor -n 5
DONE
