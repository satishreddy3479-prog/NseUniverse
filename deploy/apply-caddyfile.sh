#!/usr/bin/env bash
# Re-create /etc/caddy/Caddyfile from deploy/Caddyfile.template, check it, keep the old one, reload Caddy.
# Run on the server as root after a change to the template (a normal deploy does not touch Caddy's config):
#   sudo bash /opt/nse-universe/current/deploy/apply-caddyfile.sh nseuniverse.duckdns.org
set -euo pipefail
domain="${1:?usage: apply-caddyfile.sh <domain>}"
here="$(cd "$(dirname "$0")" && pwd)"
new="$(mktemp)"
sed "s/__DOMAIN__/${domain}/" "$here/Caddyfile.template" > "$new"
caddy validate --config "$new" --adapter caddyfile
cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
install -m 644 "$new" /etc/caddy/Caddyfile
rm -f "$new"
systemctl reload caddy
sleep 2
systemctl is-active caddy
for u in manifest.webmanifest sw.js icon-192.png icon-512.png; do
  printf '%-26s' "/$u"; curl -s -o /dev/null -w '%{http_code}\n' "https://${domain}/$u"
done
printf '%-26s' "/ (needs the login)"; curl -s -o /dev/null -w '%{http_code}\n' "https://${domain}/"
printf '%-26s' "/api/status (login)"; curl -s -o /dev/null -w '%{http_code}\n' "https://${domain}/api/status"
