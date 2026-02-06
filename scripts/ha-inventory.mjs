#!/usr/bin/env node
/**
 * Generate a markdown inventory of Home Assistant entities grouped by area and domain.
 * Uses /api/states plus /api/template area_name(entity_id).
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = '/root/.openclaw/workspace';
const SECRETS_DIR = path.join(WORKSPACE, 'secrets');

function readSecret(name) {
  try { return fs.readFileSync(path.join(SECRETS_DIR, name), 'utf8').trim(); } catch { return ''; }
}

const HA_URL = (process.env.HA_URL || readSecret('ha_url') || 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || readSecret('ha_token');

function die(msg) { console.error(msg); process.exit(1); }
if (!HA_TOKEN) die('Missing HA token (HA_TOKEN or secrets/ha_token).');

async function ha(method, p, body) {
  const res = await fetch(`${HA_URL}${p}`, {
    method,
    headers: {
      'Authorization': `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HA HTTP ${res.status}: ${text.slice(0,500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const importantDomains = new Set([
  'light','switch','climate','fan','cover','lock','media_player','vacuum','scene','script','automation','input_boolean'
]);

function arg(name, def=null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i+1];
  if (!v || v.startsWith('--')) return true;
  return v;
}

const outPath = arg('--out', path.join(WORKSPACE, 'memory', 'homeassistant-overview.md'));
const mode = arg('--mode', 'control'); // control|full

function domainOf(eid) { return eid.includes('.') ? eid.split('.',1)[0] : '(none)'; }

function friendly(e) {
  return (e?.attributes?.friendly_name || '').trim();
}

(async () => {
  const states = await ha('GET','/api/states');
  if (!Array.isArray(states)) die('Unexpected /api/states response');

  // Get area_name list aligned by entity order.
  const entityIds = states.map(s => s.entity_id);
  const template = '{{ states | map(attribute="entity_id") | map("area_name") | list | tojson }}';
  const areaListJson = await ha('POST','/api/template', { template });
  // Home Assistant may return either a JSON string (e.g. "[...]") or a raw value.
  const areaList = (typeof areaListJson === 'string') ? JSON.parse(areaListJson) : areaListJson;
  if (!Array.isArray(areaList) || areaList.length !== states.length) {
    throw new Error('Area list mismatch');
  }

  const enriched = states.map((s, i) => ({
    entity_id: s.entity_id,
    domain: domainOf(s.entity_id),
    state: s.state,
    name: friendly(s) || null,
    area: areaList[i] || 'Unassigned',
  }));

  let filtered = enriched;
  if (mode === 'control') {
    filtered = enriched.filter(e => importantDomains.has(e.domain));
  }

  // group
  const byArea = new Map();
  for (const e of filtered) {
    const k = e.area || 'Unassigned';
    if (!byArea.has(k)) byArea.set(k, []);
    byArea.get(k).push(e);
  }

  const areaNames = [...byArea.keys()].sort((a,b) => (a==='Unassigned') - (b==='Unassigned') || a.localeCompare(b));
  const domOrder = ['light','switch','climate','fan','cover','lock','media_player','vacuum','scene','script','automation','input_boolean'];
  const domKey = (d) => (domOrder.includes(d) ? domOrder.indexOf(d) : 999);

  const lines = [];
  lines.push('# Home Assistant Inventory');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: ${HA_URL}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Entities (mode=${mode}): **${filtered.length}**`);
  lines.push(`- Areas: **${areaNames.length}**`);
  lines.push('');

  for (const area of areaNames) {
    const ents = byArea.get(area);
    lines.push(`## ${area} (${ents.length})`);
    // domain groups
    const byDom = new Map();
    for (const e of ents) {
      if (!byDom.has(e.domain)) byDom.set(e.domain, []);
      byDom.get(e.domain).push(e);
    }
    const doms = [...byDom.keys()].sort((a,b) => domKey(a)-domKey(b) || a.localeCompare(b));

    for (const dom of doms) {
      const items = byDom.get(dom).sort((a,b) => a.entity_id.localeCompare(b.entity_id));
      lines.push(`### ${dom} (${items.length})`);
      for (const e of items) {
        const name = e.name && e.name !== e.entity_id ? ` — ${e.name}` : '';
        lines.push(`- \`${e.entity_id}\`${name} = **${e.state}**`);
      }
      lines.push('');
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(outPath);
})();
