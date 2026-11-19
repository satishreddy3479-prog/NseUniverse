#!/usr/bin/env bash
# Proves the public front door asks for a login before it shows or controls anything (read-only: OPTIONS requests, no credentials sent).
#   ssh nse-server bash /opt/nse-universe/current/deploy/check-front-door.sh
# Exit 0: every data and control path answers 401 and only the app's install files are open. Exit 1: something answers without a login.
# The backend itself trusts the proxy (its control endpoints accept loopback clients), so this is the only gate: run it after any Caddy change.
set -u
DOMAIN=${NSE_DOMAIN:-$(grep -m1 -E '^[A-Za-z0-9._-]+ \{' /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1)}
[ -n "$DOMAIN" ] || { echo "no domain found in /etc/caddy/Caddyfile (set NSE_DOMAIN)"; exit 2; }
bad=0
for p in / /api/health /api/status /api/stream/status /api/stream/start /api/stream/stop /api/servermgmt/overview /api/strategy/automation /ws/market-data; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X OPTIONS "https://$DOMAIN$p" || echo 000)
  if [ "$code" = 401 ]; then echo "ok   $p -> 401"; else echo "OPEN $p -> $code"; bad=1; fi
done
for p in /manifest.webmanifest /sw.js; do   # the install files are open on purpose (they hold no data)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN$p" || echo 000)
  echo "info $p -> $code (open by design)"
done
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':8010$' | grep -v '^127\.0\.0\.1:' | grep -q .; then echo "OPEN the backend listens on a non-loopback address"; bad=1; else echo "ok   the backend is bound to loopback only"; fi
[ "$bad" = 0 ] && echo "front door: closed" || echo "front door: NOT CLOSED"
exit "$bad"
