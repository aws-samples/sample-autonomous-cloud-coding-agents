#!/usr/bin/env node
/**
 * Validate that every mirrored doc page is in sidebar.yaml and every nav slug exists on disk.
 * Run: node scripts/validate-sidebar.mjs (from docs/)
 */
import fs from 'node:fs';
import path from 'node:path';

const docsRoot = path.resolve(import.meta.dirname, '..');
const contentRoot = path.join(docsRoot, 'src', 'content', 'docs');
const manifestPath = path.join(docsRoot, 'sidebar.yaml');

function parseManifest(raw) {
  const slugs = [];
  const excludePrefixes = [];
  let section = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'slugs:') {
      section = 'slugs';
      continue;
    }
    if (trimmed === 'exclude_orphans:') {
      section = 'exclude';
      continue;
    }
    if (trimmed.startsWith('- ') && section === 'slugs') {
      slugs.push(trimmed.slice(2).trim());
    }
    if (trimmed.startsWith('- ') && section === 'exclude') {
      excludePrefixes.push(trimmed.slice(2).trim());
    }
  }
  return { slugs: new Set(slugs), excludePrefixes };
}

function fileStemToSlug(relativePath) {
  return relativePath
    .replace(/\.(md|mdx)$/i, '')
    .split('/')
    .map((part) =>
      part
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase(),
    )
    .join('/');
}

function collectMirrorSlugs(dir, prefix = '') {
  const slugs = new Set();
  if (!fs.existsSync(dir)) return slugs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const s of collectMirrorSlugs(path.join(dir, entry.name), rel)) slugs.add(s);
    } else if (/\.(md|mdx)$/i.test(entry.name)) {
      slugs.add(fileStemToSlug(rel));
    }
  }
  return slugs;
}

function slugExistsOnDisk(slug) {
  if (slug === 'index') {
    return fs.existsSync(path.join(contentRoot, 'index.mdx'));
  }
  const parts = slug.split('/');
  const filePart = parts.pop();
  let current = contentRoot;
  for (const segment of parts) {
    if (!fs.existsSync(current)) return false;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const dirMatch = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === segment.toLowerCase(),
    );
    if (!dirMatch) return false;
    current = path.join(current, dirMatch.name);
  }
  if (!fs.existsSync(current)) return false;
  return fs.readdirSync(current).some(
    (f) => f.replace(/\.(md|mdx)$/i, '').toLowerCase() === filePart.toLowerCase(),
  );
}

const { slugs: manifestSlugs, excludePrefixes } = parseManifest(
  fs.readFileSync(manifestPath, 'utf8'),
);
const mirrorSlugs = collectMirrorSlugs(contentRoot);

const isExcluded = (slug) =>
  excludePrefixes.some((p) => slug === p || slug.startsWith(`${p}/`));

const orphans = [...mirrorSlugs]
  .filter((s) => s !== 'index' && !isExcluded(s) && !manifestSlugs.has(s))
  .sort();

const missing = [...manifestSlugs]
  .filter((s) => !slugExistsOnDisk(s))
  .sort();

let failed = false;
if (orphans.length) {
  failed = true;
  console.error('Orphan mirror pages (not in sidebar.yaml):');
  for (const s of orphans) console.error(`  - ${s}`);
}
if (missing.length) {
  failed = true;
  console.error('Sidebar slugs with no mirror file:');
  for (const s of missing) console.error(`  - ${s}`);
}

if (failed) process.exit(1);
console.log(
  `Sidebar manifest OK (${manifestSlugs.size} slugs, ${mirrorSlugs.size} mirror files scanned).`,
);
