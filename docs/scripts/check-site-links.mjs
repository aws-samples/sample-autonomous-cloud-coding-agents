import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const base = '/sample-autonomous-cloud-coding-agents/';
const pages = fs.readdirSync(root, { recursive: true }).filter(file => file.endsWith('.html'));
if (pages.length < 10) throw new Error('Expected a built documentation site before checking links');

const errors = new Set();
const contents = new Map();
function read(file) {
  if (!contents.has(file)) contents.set(file, fs.readFileSync(file, 'utf8'));
  return contents.get(file);
}

for (const file of pages) {
  const origin = `https://local${base}${file.replace(/index\.html$/, '')}`;
  for (const match of read(path.join(root, file)).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    // This check is offline. External availability is outside its scope.
    if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
    const url = new URL(href, origin);
    if (!url.pathname.startsWith(base)) {
      errors.add(`${file}: link escapes the site's base: ${href}`);
      continue;
    }
    let target = path.join(root, decodeURIComponent(url.pathname.slice(base.length)));
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, 'index.html');
    }
    if (!fs.existsSync(target)) {
      errors.add(`${file}: missing page: ${href}`);
    } else if (url.hash && !read(target).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) {
      errors.add(`${file}: missing anchor: ${href}`);
    }
  }
}

if (errors.size) throw new Error(`Broken documentation links:\n${[...errors].join('\n')}`);
console.log(`Checked internal page and anchor links in ${pages.length} rendered pages.`);
