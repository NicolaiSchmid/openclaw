#!/usr/bin/env node
/**
 * Home Assistant REST helper.
 *
 * Reads:
 * - HA_URL from env or /root/.openclaw/workspace/secrets/ha_url (fallback: http://homeassistant.local:8123)
 * - HA_TOKEN from env or /root/.openclaw/workspace/secrets/ha_token
 *
 * Usage:
 *   node scripts/ha.mjs ping
 *   node scripts/ha.mjs state <entity_id>
 *   node scripts/ha.mjs call <domain> <service> '<json>'
 *   node scripts/ha.mjs list [--domain <domain>]
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = '/root/.openclaw/workspace';
const SECRETS_DIR = path.join(WORKSPACE, 'secrets');

function readSecret(name) {
  try {
    return fs.readFileSync(path.join(SECRETS_DIR, name), 'utf8').trim();
  } catch {
    return '';
  }
}

const HA_URL = (process.env.HA_URL || readSecret('ha_url') || 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || readSecret('ha_token');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!HA_TOKEN) {
  die('HA token missing. Set HA_TOKEN or write it to /root/.openclaw/workspace/secrets/ha_token (chmod 600).');
}

async function haFetch(p, { method = 'GET', body } = {}) {
  const url = `${HA_URL}${p}`;
  const headers = {
    'Authorization': `Bearer ${HA_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    // Don’t print token; just show status + response body.
    throw new Error(`HA HTTP ${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  }

  return json ?? text;
}

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

const [,, cmd, ...rest] = process.argv;

(async () => {
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      console.log('Usage: node scripts/ha.mjs ping|state|call|list ...');
      process.exit(0);
    }

    if (cmd === 'ping') {
      const out = await haFetch('/api/');
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'state') {
      const entity = rest[0];
      if (!entity) die('Usage: node scripts/ha.mjs state <entity_id>');
      const out = await haFetch(`/api/states/${encodeURIComponent(entity)}`);
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'call') {
      const [domain, service, dataJson] = rest;
      if (!domain || !service) die("Usage: node scripts/ha.mjs call <domain> <service> '<json>'");
      let data = {};
      if (dataJson) {
        try { data = JSON.parse(dataJson); } catch { die('Invalid JSON payload.'); }
      }
      const out = await haFetch(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
        method: 'POST',
        body: data,
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'list') {
      const domain = getArg('--domain');
      const states = await haFetch('/api/states');
      if (!Array.isArray(states)) {
        console.log(JSON.stringify(states, null, 2));
        return;
      }
      const filtered = domain
        ? states.filter((s) => typeof s?.entity_id === 'string' && s.entity_id.startsWith(domain + '.'))
        : states;

      const compact = filtered
        .map((s) => ({ entity_id: s.entity_id, state: s.state, name: s.attributes?.friendly_name }))
        .sort((a,b) => (a.entity_id || '').localeCompare(b.entity_id || ''));

      console.log(JSON.stringify(compact, null, 2));
      return;
    }

    die('Unknown command. Use: ping | state | call | list');
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(2);
  }
})();
