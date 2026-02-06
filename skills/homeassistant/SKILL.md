---
name: homeassistant
description: Control Home Assistant (lights, switches, climate, scenes, scripts) via the Home Assistant REST API. Use when Nicolai asks to control devices at home, query entity states, or run Home Assistant services.
---

# Home Assistant (REST) — Quick Use

## Security first
- Prefer a **dedicated Home Assistant user** for this assistant.
- Use a **Long-Lived Access Token** (LLAT) from that user.
- **Never** commit tokens to git; store them in `secrets/` (gitignored).
- If HA is exposed on the public internet, ensure **HTTPS**, strong auth, and ideally IP restrictions / VPN.

## Setup (one-time)
1) Set your HA base URL (you have: `https://ghar.nicolaischmid.de`).
2) Save token to a local secret file:
   - `mkdir -p /root/.openclaw/workspace/secrets`
   - `chmod 700 /root/.openclaw/workspace/secrets`
   - write token to: `/root/.openclaw/workspace/secrets/ha_token`
   - `chmod 600 /root/.openclaw/workspace/secrets/ha_token`

Optional env overrides:
- `HA_URL` (default taken from `secrets/ha_url` if present)
- `HA_TOKEN` (default read from `secrets/ha_token`)

## Inventory / context
- The current device/entity overview lives in:
  - `skills/homeassistant/references/inventory-nice.md` (most useful controls)
  - `skills/homeassistant/references/inventory.md` (broader controllable list)
- Refresh anytime by running:
  - `node scripts/ha-refresh-context.mjs`

## Commands
Wrapper script (JSON by default):

- Ping:
  - `node scripts/ha.mjs ping`

- Get entity state:
  - `node scripts/ha.mjs state light.living_room`

- Call a service:
  - `node scripts/ha.mjs call light turn_on '{"entity_id":"light.living_room","brightness_pct":50}'`

- List entities (compact):
  - `node scripts/ha.mjs list --domain light`

## REST endpoints (reference)
- `GET /api/`
- `GET /api/states/<entity_id>`
- `POST /api/services/<domain>/<service>` with JSON body

Docs:
- https://developers.home-assistant.io/docs/api/rest/
