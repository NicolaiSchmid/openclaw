#!/usr/bin/env node
/**
 * Newsletter triage: propose candidates in INBOX to move to Reading.
 * - Generates a ranked list (lowest confidence → highest).
 * - Writes state to memory/newsletter-triage-state.json (gitignored).
 * - Can optionally apply moves (move selected ids).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const cmd = argv[0] || "propose";

function getArg(name, def = null) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v ?? def;
}

const account = getArg("--account", "wasc");
const sourceFolder = getArg("--source", null);
const limit = Number(getArg("--limit", "200"));
const maxItems = Number(getArg("--max", "20"));

const rulesPath = getArg(
  "--rules",
  path.join(process.cwd(), "config", "newsletter-rules.json"),
);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8" });
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function senderShort(from) {
  const addr = norm(from?.addr);
  if (!addr) return norm(from?.name) || "unknown";

  // keep useful handles like marius@peec
  const m = addr.match(/^([^@]+)@([^@]+)$/);
  if (!m) return addr;
  const user = m[1];
  const host = m[2];

  // shorten common newsletter platforms
  if (host === "substack.com") return `${user}@substack`;
  if (host === "mail.beehiiv.com") return `${user}@beehiiv`;

  // shorten host a bit
  const hostParts = host.split(".");
  if (hostParts.length >= 2) {
    const shortHost = hostParts.slice(-2).join(".");
    return `${user}@${shortHost}`;
  }

  return addr;
}

function domainOf(addr) {
  const a = norm(addr);
  const i = a.lastIndexOf("@");
  if (i === -1) return "";
  return a.slice(i + 1);
}

function containsAny(hay, needles) {
  const h = norm(hay);
  return needles.some((n) => h.includes(norm(n)));
}

function scoreEmail(e, rules) {
  const fromAddr = norm(e?.from?.addr);
  const fromName = norm(e?.from?.name);
  const subj = norm(e?.subject);
  const dom = domainOf(fromAddr);

  const allowDomains = rules?.allow?.domains || [];
  const allowAddrs = rules?.allow?.addresses || [];
  const blockDomains = rules?.block?.domains || [];
  const blockAddrs = rules?.block?.addresses || [];
  const blockKeywords = rules?.block?.keywords || [];
  const subjectSignals = rules?.signals?.subjectKeywords || [];

  const blob = `${fromAddr} ${fromName} ${subj}`;

  // hard blocks first
  if (blockAddrs.includes(fromAddr)) {
    return { confidence: 0, blocked: true, reasons: ["blocked: address"] };
  }
  if (dom && blockDomains.includes(dom)) {
    return { confidence: 0, blocked: true, reasons: ["blocked: domain"] };
  }
  if (containsAny(blob, blockKeywords)) {
    return { confidence: 0, blocked: true, reasons: ["blocked: keyword"] };
  }

  let confidence = 0;
  const reasons = [];

  // Explicit allowlist = highest confidence
  if (allowAddrs.includes(fromAddr)) {
    confidence = Math.max(confidence, 95);
    reasons.push("allow: address");
  }

  // Newsletter platform domains = strong but not absolute
  if (dom && allowDomains.includes(dom)) {
    confidence = Math.max(confidence, 65);
    reasons.push("allow: domain");
  }

  // Subject signals = medium confidence
  if (containsAny(subj, subjectSignals)) {
    confidence += 15;
    reasons.push("signal: subject");
  }

  // Mild boosts for typical longform sender naming
  if (dom === "substack.com" || dom === "mail.beehiiv.com") {
    confidence += 10;
    reasons.push("signal: newsletter platform");
  }

  if (fromName.includes("newsletter") || fromName.includes("digest")) {
    confidence += 5;
    reasons.push("signal: sender name");
  }

  // clamp
  confidence = Math.max(0, Math.min(100, confidence));

  return { confidence, blocked: false, reasons };
}

function listInboxEnvelopes({ account, folder, limit }) {
  // Newest-first listing, then slice to limit.
  // (Himalaya doesn't expose offset well in one call for huge inboxes; 200 is fine.)
  const out = run("himalaya", [
    "envelope",
    "list",
    "--account",
    account,
    "--folder",
    folder,
    "--output",
    "json",
    "--page-size",
    String(limit),
    "order",
    "by",
    "date",
    "desc",
  ]);
  return JSON.parse(out);
}

function formatProposal({ items, rules }) {
  const now = new Date();
  const header = `**Reading triage** (${now.toISOString().slice(0, 16).replace("T", " ")} UTC)`;

  const lines = [
    header,
    "",
    `Proposed moves to **${rules.targetFolder}** (lowest confidence → highest):`,
    "",
  ];

  if (!items.length) {
    lines.push("• (no candidates right now)");
    lines.push("");
    lines.push(
      "Reply with: `add allow domain <domain>` / `add allow sender <email>` to teach me what counts as Reading.",
    );
    return lines.join("\n");
  }

  items.forEach((it, idx) => {
    const n = idx + 1;
    const from = `**${it.sender}**`;
    const subj = it.subject || "(no subject)";
    const why = it.reasons.length ? ` (${it.reasons.join(", ")})` : "";
    const id = `\`#${it.id}\``;
    lines.push(`${n}. ${from} – ${subj} — *${it.confidence}* ${id}${why}`);
  });

  lines.push("");
  lines.push("Reply with one of:");
  lines.push("- `move all` (moves items with confidence ≥ " + rules.thresholds.defaultMoveMin + ")");
  lines.push("- `move 1 3 5` (moves selected numbers)");
  lines.push("- `not 2` (teaches me: sender is NOT Reading → adds to blocklist)");
  lines.push("- `always 4` (teaches me: sender IS Reading → adds to allowlist)");

  return lines.join("\n");
}

function statePath() {
  return path.join(process.cwd(), "memory", "newsletter-triage-state.json");
}

function buildCandidates(envelopes, rules) {
  const proposed = [];
  for (const e of envelopes) {
    const { confidence, blocked, reasons } = scoreEmail(e, rules);
    if (blocked) continue;
    if (confidence < (rules?.thresholds?.minPropose ?? 25)) continue;

    proposed.push({
      id: e.id,
      date: e.date,
      from: e.from,
      sender: senderShort(e.from),
      subject: e.subject,
      confidence,
      reasons,
    });
  }

  // low→high confidence, then newest→oldest (most relevant at the bottom)
  proposed.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence - b.confidence;
    // date desc
    return String(b.date).localeCompare(String(a.date));
  });

  // cap (take highest relevance among the scanned set)
  return proposed.slice(-maxItems);
}

function applyMove({ account, sourceFolder, targetFolder, ids }) {
  if (!ids.length) return "(nothing to move)";
  run("himalaya", [
    "message",
    "move",
    "--account",
    account,
    "--folder",
    sourceFolder,
    targetFolder,
    ...ids,
  ]);
  return `Moved ${ids.length} message(s) from ${sourceFolder} → ${targetFolder}.`;
}

// --- commands ---

const rules = readJson(rulesPath);
if (sourceFolder) rules.sourceFolder = sourceFolder;

if (cmd === "propose") {
  const envs = listInboxEnvelopes({
    account,
    folder: rules.sourceFolder,
    limit,
  });
  const items = buildCandidates(envs, rules);

  writeJson(statePath(), {
    createdAt: new Date().toISOString(),
    account,
    rulesPath,
    sourceFolder: rules.sourceFolder,
    targetFolder: rules.targetFolder,
    items,
  });

  process.stdout.write(formatProposal({ items, rules }) + "\n");
  process.exit(0);
}

function updateRuleFile(rulesPath, mutateFn) {
  const rules = readJson(rulesPath);
  mutateFn(rules);
  writeJson(rulesPath, rules);
}

function parseReply(text) {
  const t = norm(text);
  const mMoveAll = t.match(/^move\s+all$/);
  const mMoveSome = t.match(/^move\s+([0-9\s]+)$/);
  const mNot = t.match(/^not\s+([0-9]+)$/);
  const mAlways = t.match(/^always\s+([0-9]+)$/);
  if (mMoveAll) return { kind: "move_all" };
  if (mMoveSome) {
    const nums = mMoveSome[1]
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { kind: "move_some", nums };
  }
  if (mNot) return { kind: "not", n: Number(mNot[1]) };
  if (mAlways) return { kind: "always", n: Number(mAlways[1]) };
  return { kind: "unknown" };
}

if (cmd === "reply") {
  const text = argv.slice(1).join(" ").trim();
  const state = readJson(statePath());
  const items = state.items || [];

  const parsed = parseReply(text);

  if (parsed.kind === "move_all") {
    const moveMin = rules.thresholds.defaultMoveMin ?? 65;
    const ids = items.filter((it) => it.confidence >= moveMin).map((it) => it.id);
    const msg = applyMove({
      account,
      sourceFolder: rules.sourceFolder,
      targetFolder: rules.targetFolder,
      ids,
    });
    process.stdout.write(msg + "\n");
    process.exit(0);
  }

  if (parsed.kind === "move_some") {
    const ids = parsed.nums
      .map((n) => items[n - 1])
      .filter(Boolean)
      .map((it) => it.id);
    const msg = applyMove({
      account,
      sourceFolder: rules.sourceFolder,
      targetFolder: rules.targetFolder,
      ids,
    });
    process.stdout.write(msg + "\n");
    process.exit(0);
  }

  if (parsed.kind === "not") {
    const it = items[parsed.n - 1];
    if (!it) {
      process.stdout.write("Unknown item number.\n");
      process.exit(1);
    }
    const addr = norm(it?.from?.addr);
    updateRuleFile(rulesPath, (r) => {
      r.block.addresses = Array.from(new Set([...(r.block.addresses || []), addr])).filter(Boolean);
    });
    process.stdout.write(`Okay — added ${addr} to blocklist.\n`);
    process.exit(0);
  }

  if (parsed.kind === "always") {
    const it = items[parsed.n - 1];
    if (!it) {
      process.stdout.write("Unknown item number.\n");
      process.exit(1);
    }
    const addr = norm(it?.from?.addr);
    updateRuleFile(rulesPath, (r) => {
      r.allow.addresses = Array.from(new Set([...(r.allow.addresses || []), addr])).filter(Boolean);
    });
    process.stdout.write(`Nice — added ${addr} to allowlist.\n`);
    process.exit(0);
  }

  process.stdout.write(
    "I didn't understand. Try: `move all`, `move 1 3`, `not 2`, or `always 4`.\n",
  );
  process.exit(2);
}

if (cmd === "apply") {
  const ids = argv.filter((a) => /^\d+$/.test(a));
  const msg = applyMove({
    account,
    sourceFolder: rules.sourceFolder,
    targetFolder: rules.targetFolder,
    ids,
  });
  process.stdout.write(msg + "\n");
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(2);
