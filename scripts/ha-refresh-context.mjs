#!/usr/bin/env node
/**
 * Refresh Home Assistant context markdown files for the skill.
 * Writes into: skills/homeassistant/references/
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = '/root/.openclaw/workspace';
const SECRETS_DIR = path.join(WORKSPACE, 'secrets');
const OUT_DIR = path.join(WORKSPACE, 'skills', 'homeassistant', 'references');

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

function domainOf(eid) { return eid.includes('.') ? eid.split('.',1)[0] : '(none)'; }

function friendlyName(s) {
  return (s?.attributes?.friendly_name || '').trim();
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g,'\\|');
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const states = await ha('GET','/api/states');
  if (!Array.isArray(states)) die('Unexpected /api/states response');

  // Areas list
  const areasStr = await ha('POST','/api/template', { template: '{{ areas() | join("|\") }}' });
  const areas = String(areasStr || '').split('|').filter(Boolean);

  // area_name per entity (aligned to states order)
  const areaListRaw = await ha('POST','/api/template', {
    template: '{{ states | map(attribute="entity_id") | map("area_name") | list | tojson }}'
  });
  const areaList = (typeof areaListRaw === 'string') ? JSON.parse(areaListRaw) : areaListRaw;

  const enriched = states.map((s, i) => ({
    entity_id: s.entity_id,
    domain: domainOf(s.entity_id),
    state: s.state,
    name: friendlyName(s) || null,
    area: (Array.isArray(areaList) ? areaList[i] : null) || 'Unassigned',
  }));

  const importantDomains = new Set([
    'light','switch','climate','fan','cover','lock','media_player','vacuum','scene','script','automation','input_boolean'
  ]);

  const control = enriched.filter(e => importantDomains.has(e.domain));

  // "Nice" = what humans typically control + a small curated subset of switches
  const niceNonSwitchDomains = new Set(['light','climate','fan','cover','lock','media_player','vacuum','scene','script']);
  const nice = control.filter(e => {
    if (niceNonSwitchDomains.has(e.domain)) return true;
    if (e.domain !== 'switch') return false;
    const n = (e.name || '').toLowerCase();
    if (!n.startsWith('[')) return false; // keep only room-labeled switches
    if (n.includes('internet access')) return false;
    if (n.includes('child lock')) return false;
    if (n.includes('schedule')) return false;
    return true;
  });

  function writeInventoryMd(filePath, list, title) {
    const byArea = groupBy(list, e => e.area || 'Unassigned');
    const areaNames = [...byArea.keys()].sort((a,b) => (a==='Unassigned') - (b==='Unassigned') || a.localeCompare(b));
    const domOrder = ['light','switch','climate','fan','cover','lock','media_player','vacuum','scene','script','automation','input_boolean'];
    const domKey = (d) => (domOrder.includes(d) ? domOrder.indexOf(d) : 999);

    const lines=[];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`Source: ${HA_URL}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Areas');
    lines.push(`- ${areas.join(', ') || '(none)'}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- Entities: **${list.length}**`);
    lines.push(`- Areas with entities: **${areaNames.length}**`);
    lines.push('');

    for (const area of areaNames) {
      const ents = byArea.get(area);
      lines.push(`## ${area} (${ents.length})`);
      const byDom = groupBy(ents, e => e.domain);
      const doms = [...byDom.keys()].sort((a,b) => domKey(a)-domKey(b) || a.localeCompare(b));
      for (const dom of doms) {
        const items = byDom.get(dom).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));
        lines.push(`### ${dom} (${items.length})`);
        for (const e of items) {
          const name = e.name && e.name !== e.entity_id ? ` — ${mdEscape(e.name)}` : '';
          lines.push(`- \`${e.entity_id}\`${name} = **${mdEscape(e.state)}**`);
        }
        lines.push('');
      }
    }

    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  }

  writeInventoryMd(path.join(OUT_DIR,'inventory.md'), control, 'Home Assistant Control Inventory');
  writeInventoryMd(path.join(OUT_DIR,'inventory-nice.md'), nice, 'Home Assistant Inventory (Nice / Common Controls)');

  console.log('WROTE', path.join(OUT_DIR,'inventory.md'));
  console.log('WROTE', path.join(OUT_DIR,'inventory-nice.md'));
})();
