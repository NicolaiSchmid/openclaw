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

function shouldIgnoreEmail(e) {
  const fromAddr = (e?.from?.addr || "").toLowerCase();
  const fromName = (e?.from?.name || "").toLowerCase();
  const subj = (e?.subject || "").toLowerCase();

  // User rules (Nicolai):
  // - ImmoScout new offers don't matter
  // - thinkimmo doesn't matter
  if (fromAddr.includes("immobilienscout24")) return true;
  if (fromName.includes("immobilienscout24")) return true;
  if (subj.includes("immobilienscout")) return true;

  if (fromAddr.includes("thinkimmo")) return true;
  if (subj.includes("thinkimmo")) return true;

  return false;
}

function stripUrls(text) {
  // Remove http(s):// URLs and www. URLs
  let s = String(text || "");
  // Full URLs with protocol
  s = s.replace(/https?:\/\/[^\s<>"\])\}]+/gi, "");
  // www. URLs without protocol
  s = s.replace(/www\.[^\s<>"\])\}]+/gi, "");
  // Clean up leftover artifacts
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function senderShort(e) {
  const name = String(e?.from?.name || "").trim();
  const addr = String(e?.from?.addr || "").trim();

  const genericLocals = new Set([
    "info",
    "hello",
    "support",
    "team",
    "contact",
    "noreply",
    "no-reply",
    "notifications",
    "notification",
    "mail",
    "mailer",
  ]);

  if (addr.includes("@")) {
    const [localRaw, domainRaw] = addr.split("@");
    const local = (localRaw || "").toLowerCase();
    const domain = (domainRaw || "").toLowerCase();
    const domainLabel = (domain.split(".")[0] || domain).replace(/[^a-z0-9-]/g, "");

    if (!local || genericLocals.has(local)) return domainLabel || domain || name || "(unknown)";
    if (!domainLabel) return local;

    // wanted format example: marius@peec
    return `${local}@${domainLabel}`;
  }

  // fallback to name (lowercased, compact)
  if (name) return name.toLowerCase().replace(/\s+/g, "");
  return "(unknown)";
}

function cleanSubject(subj) {
  let s = String(subj || "").trim();
  s = s.replace(/^\s*(re|fw|fwd)\s*:\s*/i, "");
  s = s.replace(/^test\s*:\s*/i, "");
  s = s.replace(/\s+/g, " ");
  return s;
}

function isVagueSubject(subj) {
  const s = cleanSubject(subj).toLowerCase();
  if (!s) return true;
  if (s.length <= 12) return true;
  // very generic subjects
  if (["update", "newsletter", "reminder", "notification", "hello"].includes(s)) return true;
  if (/\b(update|newsletter|reminder|notification)\b/.test(s) && s.length < 25) return true;
  return false;
}

function stripHtml(txt) {
  return String(txt || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(txt) {
  const s = stripUrls(stripHtml(txt));
  if (!s) return "";
  // split on sentence-ish boundaries
  const parts = s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\bview this post on the web\b\s*(at\b)?\s*/gi, "").trim())
    .map((p) => p.replace(/\bat\b\s*/gi, " ").trim())
    .filter(Boolean);
  return (parts[0] || s).slice(0, 180);
}

function subjectSummary(subj) {
  // lightweight rewrite to make subjects scan-friendly
  let s = cleanSubject(subj);
  s = s.replace(/^peec ai onboarding\s*\((\d+\/\d+)\)\s*-\s*/i, "Peec onboarding $1: ");
  s = s.replace(/^new comment reply on\s*/i, "Comment reply on ");
  s = stripUrls(s);
  s = s.replace(/\bview this post on the web\b\s*(at\b)?\s*/gi, "");
  s = s.replace(/\bat\b\s*/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function summarizeEmail(e, bodyText = "") {
  const from = senderShort(e);
  const subj = subjectSummary(e?.subject || "(no subject)");

  if (bodyText) {
    // if subject is vague, lead with a short content summary
    const rawSent = firstSentence(bodyText);
    const sent = stripUrls(rawSent);
    const content = sent ? ` – ${sent}${sent.length >= 170 ? "…" : ""}` : "";
    // Format: **sender** – subject-summary (en dash)
    return `**${from}** – ${subj}${content}`;
  }

  // Format: **sender** – subject-summary (en dash)
  return `**${from}** – ${subj}`;
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
  ? `- $${(((costs.cost?.estimated ?? costs.cost?.known) ?? 0)).toFixed(2)}\n- Models: ${topModelsLine(costs)}`
  : "- (Cost data unavailable)";

// Output
// Apply ignore rules + take top 10
const topInbox = inbox.filter((e) => !shouldIgnoreEmail(e)).slice(0, 10);

function blankLine() {
  console.log("");
}

// Zero-width-space line for forcing visual gaps in Telegram (which collapses consecutive blank lines)
function zwspLine() {
  console.log("\u200B");
}

function visualGap() {
  // ~4 blank lines using zero-width-space to force spacing in Telegram
  zwspLine();
  zwspLine();
  zwspLine();
  zwspLine();
}

function boldHeadline(n, title) {
  // Visual hierarchy: add a big gap ABOVE using zero-width-space lines
  visualGap();
  console.log(`**${n}) ${title}**`);
}

console.log(`**Daily Briefing — ${today} (Berlin)**`);

// 1) Inbox
boldHeadline(1, "Inbox (wasc.me) — heute");
if (topInbox.length) {
  console.log("top 10:");
  console.log("");

  let i = 1;
  for (const e of topInbox) {
    let body = "";

    // If subject looks vague OR too short, open the email (preview = don't mark seen) and add a short content summary.
    const needsBody = isVagueSubject(e?.subject) || cleanSubject(e?.subject || "").trim().length <= 8;
    if (needsBody) {
      try {
        const rawMsg = run(
          "himalaya",
          [
            "message",
            "read",
            "--account",
            account,
            "--folder",
            "INBOX",
            "--preview",
            "--no-headers",
            e.id,
          ],
          { allowFail: true },
        );
        body = rawMsg || "";
      } catch {
        body = "";
      }
    }

    console.log(`${i}) ${summarizeEmail(e, body)}`);
    i += 1;
  }
} else {
  console.log("top 10:");
  console.log("• (no emails / fetch failed)");
}

// 2) Yesterday
boldHeadline(2, "Gestern (Kurzfassung)");
for (const l of ySummaryLines) console.log(l);

// 3) Costs — bold heading with rounded total, then model bullets
function modelAlias(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("gpt-5")) return "gpt-5";
  if (m.includes("claude-opus")) return "opus";
  if (m.includes("kimi")) return "kimi";
  return null;
}

function printCostsSection(costsObj) {
  const total = (costsObj?.cost?.estimated ?? costsObj?.cost?.known) ?? 0;
  const byModel = costsObj?.byModel || {};

  const agg = new Map();
  for (const v of Object.values(byModel)) {
    const model = v?.model;
    const alias = modelAlias(model) || model;
    const c = (v?.cost?.estimated ?? v?.cost?.known) ?? 0;
    if (!alias) continue;
    agg.set(alias, (agg.get(alias) || 0) + c);
  }

  const preferred = ["gpt-5", "opus", "kimi"];
  const rest = [...agg.entries()]
    .filter(([k]) => !preferred.includes(k))
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));

  const parts = [];
  for (const k of preferred) if (agg.has(k)) parts.push([k, agg.get(k)]);
  for (const [k, v] of rest) parts.push([k, v]);

  // Visual gap before costs
  visualGap();
  
  // Bold heading with rounded total
  console.log(`**3) Costs $${Math.round(total)}**`);
  
  // Model lines as bullets
  for (const [modelName, cost] of parts.slice(0, 5)) {
    console.log(`• *${modelName}*: $${Math.round(cost || 0)}`);
  }
}

if (costs) {
  printCostsSection(costs);
} else {
  visualGap();
  console.log("**3) Costs** (unavailable)");
}

// 4) GitHub pending reviews (best-effort)
let ghReviewItems = null;
try {
  const raw = run("node", ["scripts/github-reviews.mjs", "--json"], { allowFail: true });
  ghReviewItems = jsonOrNull(raw);
} catch {
  ghReviewItems = null;
}

function ghSummary(title) {
  let t = String(title || "");
  t = t.replace(/^feat\([^)]*\):\s*/i, "");
  t = t.replace(/^fix\([^)]*\):\s*/i, "");
  t = t.replace(/^chore\([^)]*\):\s*/i, "");
  t = t.replace(/^refactor\([^)]*\):\s*/i, "");
  t = t.replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "(no title)";
}

function repoShort(nameWithOwner) {
  const s = String(nameWithOwner || "");
  const parts = s.split("/");
  return parts.length === 2 ? parts[1] : s;
}

boldHeadline(4, "GitHub review requests");
if (!ghReviewItems || ghReviewItems.ok !== true) {
  console.log("- (GitHub reviews unavailable)");
} else if (!ghReviewItems.items?.length) {
  console.log("- 0");
} else {
  for (const it of ghReviewItems.items) {
    const repo = repoShort(it?.repository?.nameWithOwner);
    const author = it?.author?.login || "(unknown)";
    const url = it?.url || "";
    const sum = ghSummary(it?.title);
    console.log(`- **${repo}** (${author}) — ${sum}${url ? " — " + url : ""}`);
  }
}

// Fokus/Questions omitted when empty
