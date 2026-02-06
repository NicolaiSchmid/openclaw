#!/usr/bin/env node
/**
 * github-reviews.mjs
 * Prints pending GitHub review requests using GitHub CLI.
 *
 * Requirements:
 * - `gh` installed
 * - `gh auth login` completed (or GH_TOKEN set)
 *
 * Usage:
 *   node scripts/github-reviews.mjs
 *   node scripts/github-reviews.mjs --json
 */

import { spawnSync } from 'node:child_process';

const json = process.argv.includes('--json');

function run(cmd, args, { allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status !== 0) {
    if (allowFail) return out;
    const err = new Error(out || `Command failed: ${cmd} ${args.join(' ')}`);
    err.status = res.status;
    throw err;
  }
  return out;
}

function gh(args, opts) {
  return run('gh', args, opts);
}

// Auth check (gh prints status info to stderr on some setups, so we capture both)
const authOut = gh(['auth', 'status'], { allowFail: true });
const authed = /Logged in to github\.com as/i.test(authOut);
if (!authed) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: 'gh not authenticated. Run: gh auth login' }));
  } else {
    console.log('- (GitHub CLI not authenticated: run `gh auth login`)');
  }
  process.exit(0);
}

// Query PRs requesting my review
const raw = gh(
  [
    'search',
    'prs',
    '--review-requested',
    '@me',
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'title,url,repository,author,createdAt,updatedAt',
  ],
  { allowFail: true },
);

// If gh fails for any reason, show a soft error
if (!raw) {
  if (json) console.log(JSON.stringify({ ok: false, error: 'gh query failed' }));
  else console.log('- (GitHub review query failed)');
  process.exit(0);
}

let items = [];
try {
  items = JSON.parse(raw || '[]');
} catch {
  // Sometimes gh may return human output; treat as error
  if (json) console.log(JSON.stringify({ ok: false, error: 'unexpected gh output', raw }));
  else console.log('- (GitHub review query returned unexpected output)');
  process.exit(0);
}

if (json) {
  console.log(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
  process.exit(0);
}

if (!items.length) {
  console.log('- Pending PR review requests: 0');
  process.exit(0);
}

console.log(`- Pending PR review requests: ${items.length}`);
for (const it of items) {
  const repo = it?.repository?.nameWithOwner || '(unknown repo)';
  const title = it?.title || '(no title)';
  const url = it?.url || '';
  console.log(`  - ${repo}: ${title} — ${url}`);
}
