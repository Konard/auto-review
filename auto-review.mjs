#!/usr/bin/env node
/**
 * auto-review.mjs
 *
 * A self-contained Node.js script (no upfront `npm install` required) that:
 *   1. Dynamically loads `dotenv` and the Octokit REST client via use-m at runtime.
 *   2. Downloads the description, all comments (issue + review), and the code-diffs of a GitHub pull-request.
 *   3. Fetches every image / file referenced in the description or comments and rewrites the Markdown to point
 *      at the local copies.
 *   4. Saves everything into …/owner-repo-pr-<id>/pull-request.md (+ an assets/ sub-folder).
 *
 * Usage:            node auto-review.mjs https://github.com/<owner>/<repo>/pull/<number>
 * Environment vars: place your `GITHUB_TOKEN` in a `.env` file at project root.
 *
 * Requirements:     Node ≥ 18 (for global `fetch` API).
 */

import * as fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';

// Load `use-m` runtime loader
const { use } = eval(
  await fetch('https://unpkg.com/use-m/use.js').then(r => r.text())
);

// Dynamically load and configure dotenv
const dotenv = await use('dotenv');
dotenv.config();

// Dynamically load Octokit REST client (includes paginate)
const { Octokit } = await use('@octokit/rest@18');

// parse & validate URL
const prURL = process.argv[2];
if (!prURL) {
  console.error('✖  Usage: node auto-review.mjs <pull-request-URL>');
  process.exit(1);
}
const m = prURL.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
if (!m) {
  console.error('✖  Not a valid GitHub pull-request URL');
  process.exit(1);
}
const [, owner, repo, numStr] = m;
const pull_number = Number(numStr);

// GitHub client
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });

// fetch PR, comments, diffs
const { data: pr } = await octo.request(
  'GET /repos/{owner}/{repo}/pulls/{pull_number}',
  { owner, repo, pull_number }
);
const issueComments = await octo.paginate(
  'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
  { owner, repo, issue_number: pull_number, per_page: 100 }
);
const reviewComments = await octo.paginate(
  'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
  { owner, repo, pull_number, per_page: 100 }
);
const files = await octo.paginate(
  'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
  { owner, repo, pull_number, per_page: 100 }
);

// prepare output folders
const dir = `${owner}-${repo}-pr-${pull_number}`;
const assetsDir = path.join(dir, 'assets');
await fs.mkdir(assetsDir, { recursive: true });

// helper: download + rewrite links
const linkRE = /!\[[^\]]*]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
const cache = new Map();

async function localiseMarkdown(md = '') {
  const tasks = [];
  md.replace(linkRE, (_, imgURL, _txt, linkURL) => {
    tasks.push(getLocal(imgURL || linkURL));
    return _;
  });
  const locals = await Promise.all(tasks);
  let i = 0;
  return md.replace(linkRE, (m, imgURL, _txt, linkURL) =>
    m.replace(imgURL || linkURL, locals[i++])
  );
}

async function getLocal(urlStr) {
  if (cache.has(urlStr)) return cache.get(urlStr);
  try {
    const res = await fetch(urlStr);
    if (!res.ok) throw new Error();
    const ext = path.extname(new URL(urlStr).pathname) || '';
    const name = `${cache.size}${ext}`;
    const full = path.join(assetsDir, name);
    await fs.writeFile(full, Buffer.from(await res.arrayBuffer()));
    const rel = path.posix.join('assets', name);
    cache.set(urlStr, rel);
    return rel;
  } catch {
    return urlStr; // leave untouched on failure
  }
}

// build Markdown document
const out = [];
out.push(`# ${pr.title}\n`);
out.push(`- **URL:** ${pr.html_url}`);
out.push(`- **Author:** @${pr.user.login}`);
out.push(`- **Created:** ${pr.created_at}\n`);
out.push('---\n## Description\n');
out.push(await localiseMarkdown(pr.body || ''));
out.push('\n---\n## Comments\n');
for (const c of issueComments) {
  out.push(`### ${c.user.login} — ${c.created_at}`);
  out.push(await localiseMarkdown(c.body));
  out.push('');
}
for (const c of reviewComments) {
  out.push(`### Review by ${c.user.login} — ${c.created_at}`);
  out.push(`File: \`${c.path}\`  (line ${c.line ?? c.original_line})`);
  out.push(await localiseMarkdown(c.body));
  out.push('');
}
out.push('\n---\n## Code changes\n');
for (const f of files) {
  out.push(`### ${f.filename}`);
  out.push('```diff');
  out.push(f.patch || '');
  out.push('```');
  out.push('');
}

// write to disk
const mdPath = path.join(dir, 'pull-request.md');
await fs.writeFile(mdPath, out.join('\n'), 'utf8');

console.log(`✔  Saved →  ${mdPath}`);
