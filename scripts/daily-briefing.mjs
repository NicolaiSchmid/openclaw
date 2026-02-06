#!/usr/bin/env node
/**
 * daily-briefing.mjs
 * Draft generator for Nicolai's daily message.
 *
 * Outputs markdown to stdout. By default: uses Europe/Berlin timezone.
 *
 * Sections:
 * - Inbox today (wasc.me)
 * - Yesterday summary (from memory/YYYY-MM-DD.md if present)
 * - Costs yesterday (via scripts/costs.mjs)
 * - Today focus & todos (placeholder)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
}

const tz = arg("--tz", "Europe/Berlin");
const account = arg("--account", "wasc");

function berlinDateISO(date = new Date()) {
  // Create an ISO date string in the given tz by using Intl.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const today = berlinDateISO(new Date());
// yesterday in tz: approximate by subtracting 26h then format in tz
const yesterday = berlinDateISO(new Date(Date.now() - 26 * 3600 * 1000));

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}

function jsonOrNull(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 1) Inbox today
let inbox = [];
let inboxMeta = { todayTotal: 0, todayUnread: 0, unreadTotal: null };
try {
  // List today's emails from INBOX (server-side date filter in himalaya query language)
  const raw = run(
    "himalaya",
    [
      "envelope",
      "list",
      "--account",
      account,
      "--folder",
      "INBOX",
      "--output",
      "json",
      "--page-size",
      "200",
      "date",
      today,
      "order",
      "by",
      "date",
      "desc",
    ],
    { allowFail: true }
  );
  const j = jsonOrNull(raw);
  if (Array.isArray(j)) {
    inbox = j;
    inboxMeta.todayTotal = j.length;
    inboxMeta.todayUnread = j.filter((e) => !(e.flags || []).includes("Seen")).length;
  }

  // Unread total: approximate by fetching first page of UNSEEN
  const rawUnread = run(
    "himalaya",
    [
      "envelope",
      "list",
      "--account",
      account,
      "--folder",
      "INBOX",
      "--output",
      "json",
      "--page-size",
      "200",
      "not",
      "flag",
      "Seen",
      "order",
      "by",
      "date",
      "desc",
    ],
    { allowFail: true }
  );
  const ju = jsonOrNull(rawUnread);
  if (Array.isArray(ju)) inboxMeta.unreadTotal = ju.length;
} catch {
  // keep placeholders
}

function formatEmailLine(e) {
  const from = e?.from?.name ? `${e.from.name} <${e.from.addr}>` : e?.from?.addr || "(unknown)";
  const subj = e?.subject || "(no subject)";
  const date = e?.date || "";
  const unread = (e?.flags || []).includes("Seen") ? "" : "(unread) ";
  return `- ${date} — ${unread}${from} — ${subj}`;
}

// 2) Yesterday summary (best-effort parse)
let ySummaryLines = [];
try {
  const yPath = path.join(process.cwd(), "memory", `${yesterday}.md`);
  if (fs.existsSync(yPath)) {
    const txt = fs.readFileSync(yPath, "utf8");
    // grab journal summary section bullets if present
    const m = txt.match(/## Journal Summary\n([\s\S]*?)(\n## |\n# |$)/);
    if (m) {
      const bullets = m[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-") || l.match(/^\d+\)/));
      ySummaryLines = bullets.slice(0, 7);
    }
  }
} catch {
  // ignore
}
if (ySummaryLines.length === 0) {
  ySummaryLines = ["- (No journal summary found yet for yesterday)"];
}

// 3) Costs yesterday
let costs = null;
try {
  const raw = run("node", ["scripts/costs.mjs", "yesterday", "--tz", tz, "--fetch-prices", "--json"], {
    allowFail: true,
  });
  costs = jsonOrNull(raw);
} catch {
  costs = null;
}

function topModelsLine(costsObj) {
  const byModel = costsObj?.byModel;
  if (!byModel || typeof byModel !== "object") return "(none)";
  const entries = Object.values(byModel)
    .map((v) => ({
      model: v?.model || "(unknown)",
      costUsd: v?.cost?.estimated ?? v?.cost?.known ?? 0,
    }))
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))
    .slice(0, 3)
    .map((m) => `${m.model} ($${(m.costUsd || 0).toFixed(4)})`);
  return entries.length ? entries.join(", ") : "(none)";
}

const costLine = costs
  ? `- Est. cost: **$${((costs.cost?.estimated ?? costs.cost?.known) ?? 0).toFixed(4)}** • tokens: **${costs.tokens?.total ?? "?"}**\n- Top models: ${topModelsLine(costs)}`
  : "- (Cost data unavailable)";

// Output
const topInbox = inbox.slice(0, 5);

console.log(`**Daily Briefing — ${today} (Berlin)**`);
console.log("");
console.log("## 1) Inbox (wasc.me) — heute");
console.log(`- Total heute: ${inboxMeta.todayTotal} (unread: ${inboxMeta.todayUnread})`);
if (inboxMeta.unreadTotal !== null) console.log(`- Unread (approx, first page): ${inboxMeta.unreadTotal}`);
if (topInbox.length) {
  console.log("- Wichtigste / neueste (Top 5):");
  for (const e of topInbox) console.log(`  ${formatEmailLine(e)}`);
} else {
  console.log("- (Keine Emails gefunden / Abruf fehlgeschlagen)");
}

console.log("");
console.log("## 2) Gestern (Kurzfassung)");
for (const l of ySummaryLines) console.log(l);

console.log("");
console.log("## 3) Costs (gestern)");
console.log(costLine);

// 4) GitHub pending reviews (best-effort)
let ghReviewsLines = [];
try {
  const raw = run("node", ["scripts/github-reviews.mjs"], { allowFail: true });
  ghReviewsLines = raw ? raw.split("\n").map((l) => l.trim()).filter(Boolean) : [];
} catch {
  ghReviewsLines = ["- (GitHub reviews unavailable)"];
}

console.log("");
console.log("## 4) GitHub — Review requests");
if (ghReviewsLines.length) for (const l of ghReviewsLines) console.log(l);
else console.log("- (none)");

console.log("");
console.log("## 5) Today — Fokus & Todos");
console.log("- Top 3:");
console.log("  1) ___");
console.log("  2) ___");
console.log("  3) ___");
console.log("");
console.log("## 6) Fragen / Entscheidungen (max 1–2)");
console.log("- ___");
