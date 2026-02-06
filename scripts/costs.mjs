#!/usr/bin/env node
/**
 * OpenClaw cost + token usage report.
 *
 * Sources:
 * - Session logs: /data/.clawdbot/agents/<agentId>/sessions/<sessionId>.jsonl
 *   (assistant message entries include usage + model)
 *
 * Notes:
 * - OpenClaw currently records usage.cost.* but it may be 0 if pricing isn't available.
 * - This script can estimate USD cost using OpenRouter model pricing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_TZ = process.env.OPENCLAW_TZ || "Europe/Berlin";
const PRICE_CACHE_PATH = path.resolve(__dirname, "openrouter-prices.json");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { tz: DEFAULT_TZ, fetchPrices: false, root: "/data/.clawdbot/agents", mode: null, start: null, end: null, json: false };

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tz") args.tz = argv[++i];
    else if (a === "--fetch-prices") args.fetchPrices = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--json") args.json = true;
    else rest.push(a);
  }

  args.mode = rest[0] || "today";
  if (args.mode === "range") {
    args.start = rest[1];
    args.end = rest[2];
    if (!args.start || !args.end) die("Usage: costs.mjs range YYYY-MM-DD YYYY-MM-DD [--tz Europe/Berlin]");
  }
  return args;
}

function ymdInTz(tsMs, tz) {
  const d = new Date(tsMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function startOfDayUtcMs(ymd, tz) {
  // Convert a YYYY-MM-DD in a given tz to a UTC ms timestamp representing that local midnight.
  // We do this by formatting a constructed UTC date and then correcting via the timezone offset.
  // Implementation uses Intl; avoids extra deps.
  const [Y, M, D] = ymd.split("-").map(Number);
  // Start from UTC midnight of same calendar day.
  const approx = Date.UTC(Y, M - 1, D, 0, 0, 0);

  // Find what local time that UTC instant corresponds to, and compute the delta to local midnight.
  const localParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(approx));

  const get = (type) => localParts.find((p) => p.type === type)?.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const hh = Number(get("hour"));
  const mm = Number(get("minute"));
  const ss = Number(get("second"));

  // If approx falls on a different local date, adjust by whole days.
  const localApproxYmd = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dayDelta = (Date.UTC(y, m - 1, d) - Date.UTC(Y, M - 1, D)) / 86400000;

  // local time-of-day offset from midnight (in seconds)
  const todSeconds = hh * 3600 + mm * 60 + ss;

  // We want local midnight -> subtract local time-of-day and compensate dayDelta.
  return approx - (dayDelta * 86400000) - (todSeconds * 1000);
}

function rangeUtcMs(mode, tz, start, end) {
  const now = Date.now();

  if (mode === "ever") return { startMs: 0, endMs: now };

  const todayYmd = ymdInTz(now, tz);

  if (mode === "today") {
    const startMs = startOfDayUtcMs(todayYmd, tz);
    return { startMs, endMs: now };
  }

  if (mode === "yesterday") {
    const startMs = startOfDayUtcMs(todayYmd, tz) - 86400000;
    const endMs = startOfDayUtcMs(todayYmd, tz);
    return { startMs, endMs };
  }

  if (mode === "week" || mode === "last7") {
    const endMs = now;
    const startMs = endMs - 7 * 86400000;
    return { startMs, endMs };
  }

  if (mode === "range") {
    // inclusive [start..end] in local dates
    const startMs = startOfDayUtcMs(start, tz);
    const endMs = startOfDayUtcMs(end, tz) + 86400000;
    return { startMs, endMs };
  }

  die(`Unknown mode: ${mode}. Use today|yesterday|week|ever|range YYYY-MM-DD YYYY-MM-DD`);
}

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function listSessionJsonlFiles(rootAgentsDir) {
  const out = [];
  // Expect /data/.clawdbot/agents/<agentId>/sessions/*.jsonl
  for (const agentDir of fs.existsSync(rootAgentsDir) ? fs.readdirSync(rootAgentsDir) : []) {
    const sessionsDir = path.join(rootAgentsDir, agentDir, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    for (const f of fs.readdirSync(sessionsDir)) {
      if (f.endsWith(".jsonl")) out.push(path.join(sessionsDir, f));
    }
  }
  return out;
}

function loadPriceCache() {
  if (!fs.existsSync(PRICE_CACHE_PATH)) return { fetchedAt: null, prices: {} };
  try {
    return JSON.parse(fs.readFileSync(PRICE_CACHE_PATH, "utf8"));
  } catch {
    return { fetchedAt: null, prices: {} };
  }
}

async function fetchOpenRouterPrices() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) die("OPENROUTER_API_KEY not set; cannot fetch pricing. (You can still get token totals without costs.)");

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${key}`,
      // Attribution headers are optional; safe to omit.
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`Failed to fetch OpenRouter models: HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const prices = {};

  for (const m of data?.data || []) {
    const id = m.id; // e.g. "openai/gpt-4.1" or "openai/gpt-5"
    const pricing = m.pricing || {};

    // OpenRouter returns string values like "0.000003" (USD per token).
    // If absent, keep undefined.
    const prompt = pricing.prompt != null ? Number(pricing.prompt) : undefined;
    const completion = pricing.completion != null ? Number(pricing.completion) : undefined;
    const image = pricing.image != null ? Number(pricing.image) : undefined;

    prices[id] = { prompt, completion, image };
  }

  const payload = { fetchedAt: new Date().toISOString(), prices };
  fs.writeFileSync(PRICE_CACHE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function normalizeModelKey(provider, model) {
  // Session logs typically store provider=openrouter and model like:
  // - "openai/gpt-5.2"
  // - "anthropic/claude-opus-4-5" (note: OpenRouter pricing uses dots: "anthropic/claude-opus-4.5")
  //
  // For OpenRouter, we try to map common "-4-5" → ".4.5" variants.
  if (!model) return null;

  const raw = String(model);
  if (provider === "openrouter") {
    // Convert "...-4-5" to "...-4.5" (only if it matches a trailing -<major>-<minor>)
    // Only do this for the Anthropic/Claude "...-4-5" style, otherwise we'd break models like "gpt-5.2".
    const mapped = raw.startsWith('anthropic/')
      ? raw.replace(/-(\d+)-(\d+)$/u, "-$1.$2")
      : raw;
    return mapped;
  }

  return `${provider}/${raw}`;
}

function money(n) {
  if (!Number.isFinite(n)) return "?";
  return `$${n.toFixed(4)}`;
}

function readJsonlLines(filePath) {
  // Stream would be nicer, but these files are usually manageable.
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\n/).filter(Boolean);
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function aggregateUsage({ startMs, endMs, tz, rootAgentsDir, priceCache }) {
  const files = listSessionJsonlFiles(rootAgentsDir);

  const totals = {
    startMs,
    endMs,
    tz,
    filesScanned: files.length,
    messagesCounted: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { known: 0, estimated: 0, missingPricingTokens: 0 },
    byModel: {},
  };

  for (const f of files) {
    let lines;
    try {
      lines = readJsonlLines(f);
    } catch {
      continue;
    }

    for (const row of lines) {
      if (row?.type !== "message") continue;
      const msg = row.message;
      if (!msg || msg.role !== "assistant") continue;

      const ts = msg.timestamp;
      if (typeof ts !== "number") continue;
      if (ts < startMs || ts >= endMs) continue;

      const usage = msg.usage;
      if (!usage) continue;

      totals.messagesCounted++;

      const provider = msg.provider || row.provider || "unknown";
      const model = msg.model || msg.modelId || row.modelId || "unknown";
      const modelKey = normalizeModelKey(provider, model) || "unknown";

      const m = (totals.byModel[modelKey] ||= {
        provider,
        model: modelKey,
        messages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { known: 0, estimated: 0, missingPricingTokens: 0 },
      });

      m.messages++;

      const inTok = usage.input || 0;
      const outTok = usage.output || 0;
      const cr = usage.cacheRead || 0;
      const cw = usage.cacheWrite || 0;
      const tot = usage.totalTokens || (inTok + outTok + cr + cw);

      totals.tokens.input += inTok;
      totals.tokens.output += outTok;
      totals.tokens.cacheRead += cr;
      totals.tokens.cacheWrite += cw;
      totals.tokens.total += tot;

      m.tokens.input += inTok;
      m.tokens.output += outTok;
      m.tokens.cacheRead += cr;
      m.tokens.cacheWrite += cw;
      m.tokens.total += tot;

      const knownCost = usage.cost?.total || 0;
      if (knownCost > 0) {
        totals.cost.known += knownCost;
        m.cost.known += knownCost;
        continue;
      }

      // Estimate cost if we have OpenRouter pricing.
      const pricing = priceCache?.prices?.[modelKey];
      const promptUsdPerTok = pricing?.prompt;
      const completionUsdPerTok = pricing?.completion;

      if (Number.isFinite(promptUsdPerTok) && Number.isFinite(completionUsdPerTok)) {
        const est = inTok * promptUsdPerTok + outTok * completionUsdPerTok;
        totals.cost.estimated += est;
        m.cost.estimated += est;
      } else {
        totals.cost.missingPricingTokens += inTok + outTok;
        m.cost.missingPricingTokens += inTok + outTok;
      }
    }
  }

  return totals;
}

function printReport(r, { json }) {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const startIso = new Date(r.startMs).toISOString();
  const endIso = new Date(r.endMs).toISOString();

  console.log(`Usage window (UTC): ${startIso}  →  ${endIso}`);
  console.log(`Timezone for labels: ${r.tz}`);
  console.log(`Files scanned: ${r.filesScanned}`);
  console.log(`Assistant messages counted: ${r.messagesCounted}`);
  console.log("");

  console.log(`Tokens: in=${r.tokens.input.toLocaleString()} out=${r.tokens.output.toLocaleString()} cacheRead=${r.tokens.cacheRead.toLocaleString()} cacheWrite=${r.tokens.cacheWrite.toLocaleString()} total=${r.tokens.total.toLocaleString()}`);

  const totalCost = r.cost.known > 0 ? r.cost.known : r.cost.estimated;
  const label = r.cost.known > 0 ? "Known" : "Estimated";
  console.log(`${label} cost: ${money(totalCost)}${r.cost.known === 0 ? " (using OpenRouter price cache if available)" : ""}`);
  if (r.cost.missingPricingTokens > 0) {
    console.log(`Missing pricing for ~${r.cost.missingPricingTokens.toLocaleString()} tokens (models not in cache).`);
  }

  console.log("\nBy model:");
  const rows = Object.values(r.byModel).sort((a, b) => (b.tokens.total - a.tokens.total));
  for (const m of rows) {
    const c = m.cost.known > 0 ? m.cost.known : m.cost.estimated;
    const cLabel = m.cost.known > 0 ? "known" : "est";
    console.log(`- ${m.model}: msgs=${m.messages} tokens=${m.tokens.total.toLocaleString()} cost(${cLabel})=${money(c)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let priceCache = loadPriceCache();
  if (args.fetchPrices) {
    priceCache = await fetchOpenRouterPrices();
  }

  const { startMs, endMs } = rangeUtcMs(args.mode, args.tz, args.start, args.end);

  const report = aggregateUsage({
    startMs,
    endMs,
    tz: args.tz,
    rootAgentsDir: args.root,
    priceCache,
  });

  printReport(report, { json: args.json });
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
