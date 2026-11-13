#!/usr/bin/env bash
# Server hardening for the SSH door and the firewall. NOT run automatically: a wrong change here can lock you out of the server.
#   sudo bash deploy/harden.sh            # report only: what is open today (changes nothing)
#   sudo bash deploy/harden.sh --apply    # make the changes listed below
#
# Do this in order, from a second terminal, and keep your first SSH window open until the last step works:
#   1. Put your public key on the server (ssh-copy-id, or append it to /root/.ssh/authorized_keys) and log in with it WITHOUT a password.
#   2. Run this with --apply. It refuses unless /root/.ssh/authorized_keys has a key.
#   3. Open a NEW terminal and ssh in again. Only then close the old one.
# What --apply does (additive, reversible by deleting /etc/ssh/sshd_config.d/99-nse-hardening.conf and `ufw disable`):
#   - SSH: key login only (no passwords), root only with a key, 3 tries per connection
#   - firewall (ufw): allow 22, 80 and 443 only, deny the rest
#   - fail2ban: ban an address after repeated failed SSH logins
set -Eeuo pipefail
apply=0; [ "${1:-}" = "--apply" ] && apply=1
echo "== today"
sshd -T 2>/dev/null | grep -iE "^(passwordauthentication|permitrootlogin|pubkeyauthentication|maxauthtries) " || true
echo "ufw:        $(ufw status 2>/dev/null | head -1 || echo not installed)"
echo "fail2ban:   $(systemctl is-active fail2ban 2>/dev/null || echo not installed)"
echo "listening:  $(ss -tln | awk 'NR>1{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' ')"
[ "$apply" = 1 ] || { echo; echo "Report only. Re-run with --apply after reading the header of this file."; exit 0; }

keys=/root/.ssh/authorized_keys
[ -s "$keys" ] || { echo "REFUSED: $keys is empty, so turning passwords off would lock you out. Add your public key first."; exit 1; }
echo "== SSH"
conf=/etc/ssh/sshd_config.d/99-nse-hardening.conf
cat > "$conf" <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
CONF
sshd -t || { rm -f "$conf"; echo "REFUSED: sshd rejected the new settings; removed them."; exit 1; }
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "== firewall"
command -v ufw >/dev/null || apt-get install -y ufw >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null && ufw status | head -8
echo "== fail2ban"
command -v fail2ban-client >/dev/null || apt-get install -y fail2ban >/dev/null
printf '[sshd]\nenabled = true\nmaxretry = 4\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/nse-sshd.local
systemctl enable --now fail2ban >/dev/null && systemctl restart fail2ban
echo "done. NOW open a new terminal and confirm you can still ssh in before closing this one."
