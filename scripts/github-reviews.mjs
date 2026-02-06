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

import { execFileSync } from 'node:child_process';

const json = process.argv.includes('--json');

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function tryGh(args) {
  return run('gh', args, { allowFail: true });
}

// Fast check for auth
const auth = tryGh(['auth', 'status']);
if (!auth || /not logged in/i.test(auth)) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: 'gh not authenticated. Run: gh auth login' }));
  } else {
    console.log('- (GitHub CLI not authenticated: run `gh auth login`)');
  }
  process.exit(0);
}

// Query PRs requesting my review
const raw = tryGh([
  'search', 'prs',
  '--review-requested', '@me',
  '--state', 'open',
  '--limit', '50',
  '--json', 'title,url,repository,author,createdAt,updatedAt',
]);

let items = [];
try { items = JSON.parse(raw || '[]'); } catch { items = []; }

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
