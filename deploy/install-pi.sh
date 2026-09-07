#!/usr/bin/env bash
# AHG badge tracker — Raspberry Pi installer (64-bit OS), beside troop-checkin.
# Fresh clone → running service:
#   sudo git clone <repo-url> /opt/ahg-badge-tracker
#   sudo chown -R "$USER" /opt/ahg-badge-tracker
#   cd /opt/ahg-badge-tracker && sudo bash deploy/install-pi.sh
# Mirrors troop-checkin's scripts/install-pi.sh so there is one install
# pattern to know. Node is only installed when missing or older than 20 —
# an existing check-in Node install is left alone.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-pi}"
NODE_MAJOR=20
NAME="ahg-badge-tracker"

echo "==> AHG badge tracker installer (app: $APP_DIR, user: $RUN_USER, service: $NAME)"
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/install-pi.sh" >&2
  exit 1
fi

# --- Node LTS (NodeSource; arm64-safe; never downgrades an existing install) -
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt $NODE_MAJOR ]]; then
  echo "==> Installing Node $NODE_MAJOR LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node -v), npm $(npm -v)"

# --- dependencies (better-sqlite3 is pinned to a version with arm64 prebuilds;
#     build tools are only a fallback if a prebuild is missing) ---------------
apt-get install -y build-essential python3 >/dev/null
cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci --omit=dev 2>/dev/null || sudo -u "$RUN_USER" npm install --omit=dev

# --- config + database ------------------------------------------------------
if [[ ! -f .env ]]; then
  sudo -u "$RUN_USER" cp .env.example .env
  chmod 600 .env
  echo "==> Created .env from .env.example — EDIT IT (PORT, CHECKIN_*, MSAL_* when Entra is ready)."
fi
sudo -u "$RUN_USER" npm run migrate

# --- built badge catalog ----------------------------------------------------
# data/badges/ is generated on the annotation PC and copied here (it holds
# copyrighted handbook text — never in git). The import is idempotent.
if [[ -d data/badges ]] && ls data/badges/*.json >/dev/null 2>&1; then
  sudo -u "$RUN_USER" npm run import:catalog
else
  echo "==> data/badges/ is empty — copy the built badges from the annotation PC, then run:"
  echo "    scp -r data/badges <pi>:$APP_DIR/data/  &&  npm run import:catalog"
fi

# --- systemd service --------------------------------------------------------
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$RUN_USER|g" \
  deploy/ahg-badge-tracker.service.template > "/etc/systemd/system/${NAME}.service"
systemctl daemon-reload
systemctl enable --now "$NAME"
sleep 2
systemctl --no-pager status "$NAME" | head -8

echo
echo "==> Done. Next steps (docs/pi-setup.md has the full walkthrough):"
echo "    1. In the check-in app's Admin -> Integrations: generate an API key and"
echo "       webhook secret; put them in $APP_DIR/.env (CHECKIN_API_KEY,"
echo "       CHECKIN_WEBHOOK_SECRET); webhook URL http://127.0.0.1:3100/webhooks/checkin"
echo "    2. sudo systemctl restart $NAME && curl -s http://127.0.0.1:3100/health"
echo "    3. When the Entra registration lands, set MSAL_TENANT_ID / MSAL_CLIENT_ID /"
echo "       LEADER_GROUP_ID / ADMIN_EMAILS / SITE_ORIGIN and restart."
