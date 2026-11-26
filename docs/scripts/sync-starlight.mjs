import fs from 'node:fs';
import path from 'node:path';

const docsBase = '/sample-autonomous-cloud-coding-agents';
const repoUrl = 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents';
const contentDir = 'docs/src/content/docs';
const handAuthored = ['index.md'];
const assets = { from: 'docs/imgs', to: 'docs/public/imgs', route: '/imgs' };

/**
 * The mirror plan: which source becomes which page under `contentDir`.
 *   split  one page per `##` section; the text before the first `##` becomes Introduction.md
 *   file   one source file, one page
 *   dir    every *.md of a directory, under a normalized file name
 */
const PLAN = [
  { split: 'docs/guides/DEVELOPER_GUIDE.md', to: 'developer-guide', introTitle: 'Developer guide introduction' },
  {
    split: 'docs/guides/USER_GUIDE.md',
    to: 'using',
    introTitle: 'Using the platform',
    moved: { 'Repository-onboarding.md': 'customizing', 'Per-repo-overrides.md': 'customizing' },
  },
  { file: 'docs/guides/QUICK_START.mdx', to: 'getting-started/Quick-start.mdx' },
  { file: 'docs/guides/DEPLOYMENT_GUIDE.md', to: 'getting-started/Deployment-guide.md' },
  { file: 'docs/guides/COST_ATTRIBUTION.md', to: 'getting-started/Cost-attribution.md' },
  { file: 'docs/guides/PROMPT_GUIDE.md', to: 'customizing/Prompt-engineering.md' },
  { file: 'docs/guides/SLACK_SETUP_GUIDE.md', to: 'using/Slack-setup-guide.md' },
  { file: 'docs/guides/LINEAR_SETUP_GUIDE.md', to: 'using/Linear-setup-guide.md' },
  { file: 'docs/guides/JIRA_SETUP_GUIDE.md', to: 'using/Jira-setup-guide.md' },
  { file: 'docs/guides/DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md', to: 'using/Deploy-preview-screenshots-guide.md' },
  { file: 'docs/guides/CEDAR_POLICY_GUIDE.md', to: 'customizing/Cedar-policies.md' },
  { file: 'CONTRIBUTING.md', to: 'developer-guide/Contributing.md' },
  { dir: 'docs/design', to: 'architecture' },
  { dir: 'docs/decisions', to: 'decisions' },
];

function normalizeFileStem(input) {
  const cleaned = input
    .replace(/\.md$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!cleaned) {
    return 'Untitled';
  }
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

/** The route Starlight serves a page at: `using/Slack-setup-guide.md` -> `/using/slack-setup-guide`. */
function routeOf(target) {
  const slug = target.replace(/\.mdx?$/i, '').toLowerCase();
  return slug === 'index' ? '/' : `/${slug}`;
}

function fencedLines(lines) {
  let open;
  return lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}(?=[^`]*$)|~{3,})/)?.[1];
    if (!open) {
      open = fence;
      return Boolean(fence);
    }
    if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) {
      open = undefined;
    }
    return true;
  });
}

function headingsOf(text) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  return lines.flatMap((line, index) => {
    const match = fenced[index] ? null : line.match(/^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    return match ? [{ index, depth: match[1].length, text: match[2] }] : [];
  });
}

/** Heading ids as GitHub and Astro compute them (the github-slugger algorithm). */
function createSlugger() {
  const seen = new Map();
  return (heading) => {
    const base = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    let slug = base;
    while (seen.has(slug)) {
      seen.set(base, seen.get(base) + 1);
      slug = `${base}-${seen.get(base)}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/**
 * GitHub numbers repeated headings across the whole source file; the site numbers them per
 * page and has no id for the heading that became the page title.
 */
function indexSources(pages) {
  const docs = new Map(
    handAuthored.map((target) => [`${contentDir}/${target}`, { route: routeOf(target), anchors: new Map() }]),
  );
  const sourceSlug = new Map();
  for (const page of pages) {
    if (!docs.has(page.source)) {
      const first = pages.find((candidate) => candidate.source === page.source && !candidate.skip);
      docs.set(page.source, { route: routeOf(first.target), anchors: new Map() });
      sourceSlug.set(page.source, createSlugger());
    }
    const doc = docs.get(page.source);
    const route = page.skip ? doc.route : routeOf(page.target);
    const slugInSource = sourceSlug.get(page.source);
    const slugInPage = createSlugger();
    if (page.heading !== undefined) {
      doc.anchors.set(slugInSource(page.heading), { route, id: '' });
    }
    for (const heading of headingsOf(page.body)) {
      doc.anchors.set(slugInSource(heading.text), { route, id: slugInPage(heading.text) });
    }
  }
  return docs;
}

const fragment = (id) => (id ? `#${id}` : '');

/** Site routes go under `docsBase`: Starlight does not prefix links in Markdown bodies. */
function resolveLink(target, page, docs, repoRoot, shown) {
  if (target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return undefined;
  }
  const [file, anchor = ''] = target.split('#');
  const source =
    file === '' ? page.source : path.posix.join(path.posix.dirname(page.source), file).replace(/\/$/, '');
  const servable =
    source.startsWith(`${assets.from}/`) &&
    fs.statSync(path.join(repoRoot, source), { throwIfNoEntry: false })?.isFile();
  if (shown && !servable) {
    throw new Error(
      `sync-starlight: ${page.source} shows the image ${target}, which is not a file in ${assets.from}/, the only directory the site serves images from. Correct the path, or move the image there.`,
    );
  }
  const doc = docs.get(source) ?? docs.get(`${source}/README.md`);
  if (doc) {
    const hit = anchor ? doc.anchors.get(anchor.toLowerCase()) : undefined;
    if (file === '') {
      if (!hit) {
        return undefined;
      }
      return hit.route === routeOf(page.target)
        ? `#${hit.id || '_top'}`
        : `${docsBase}${hit.route}${fragment(hit.id)}`;
    }
    const { route, id } = hit ?? { route: doc.route, id: anchor };
    return `${docsBase}${route}${fragment(id)}`;
  }
  if (source.startsWith('..') || !fs.existsSync(path.join(repoRoot, source))) {
    return undefined;
  }
  if (source.startsWith(`${assets.from}/`)) {
    return `${docsBase}${assets.route}${source.slice(assets.from.length)}`;
  }
  const kind = fs.statSync(path.join(repoRoot, source)).isDirectory() ? 'tree' : 'blob';
  return `${repoUrl}/${kind}/main/${source}${fragment(anchor)}`;
}

function rewriteLinks(text, resolve) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const codeOrLink =
    /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)|(!?\[[^[\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))|(\b(?:src|href)\s*=\s*(["']))([^"'\s]+)(\6)/gi;
  const rewrite = (run) =>
    run.replace(codeOrLink, (match, code, open, target, close, attribute, quote, value) => {
      if (code) {
        return match;
      }
      if (open) {
        const rewritten = resolve(target, open.startsWith('!'));
        return rewritten ? `${open}${rewritten}${close}` : match;
      }
      const rewritten = resolve(value, /^src/i.test(attribute));
      return rewritten ? `${attribute}${rewritten}${quote}` : match;
    });
  const runs = [];
  let start = 0;
  while (start < lines.length) {
    let end = start + 1;
    while (end < lines.length && fenced[end] === fenced[start]) {
      end += 1;
    }
    const run = lines.slice(start, end).join('\n');
    runs.push(fenced[start] ? run : rewrite(run));
    start = end;
  }
  return runs.join('\n');
}

/**
 * Starlight renders the frontmatter title as the page's only <h1>, so the source's own
 * `# Heading` moves into the title instead of being repeated in the body.
 */
function takeH1(text) {
  const h1 = headingsOf(text).find((heading) => heading.depth === 1);
  if (!h1) {
    return { body: text };
  }
  const lines = text.split('\n');
  lines.splice(h1.index, 1);
  if (lines[h1.index] === '' && (h1.index === 0 || lines[h1.index - 1] === '')) {
    lines.splice(h1.index, 1);
  }
  return { h1: h1.text, body: lines.join('\n') };
}

function writeFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.writeFileSync(targetPath, content, 'utf8');
  } catch (error) {
    if (error && error.code === 'EACCES' && fs.existsSync(targetPath)) {
      fs.chmodSync(targetPath, 0o644);
      fs.writeFileSync(targetPath, content, 'utf8');
      return;
    }
    throw error;
  }
}

function readSource(repoRoot, source) {
  const sourcePath = path.join(repoRoot, source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `sync-starlight: missing source ${source}. Restore the file or update PLAN in docs/scripts/sync-starlight.mjs.`,
    );
  }
  return fs.readFileSync(sourcePath, 'utf8');
}

function filePage(repoRoot, source, target) {
  const raw = readSource(repoRoot, source);
  const closing = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  const frontmatter = closing === -1 ? undefined : raw.slice(0, closing + 4);
  const { h1, body } = takeH1(frontmatter ? raw.slice(frontmatter.length) : raw);
  const stem = path.basename(source, path.extname(source));
  const title = h1 ?? normalizeFileStem(stem).replace(/-/g, ' ');
  return [{ source, target, title, heading: h1, frontmatter, body }];
}

function splitPages(repoRoot, { split: source, to, introTitle, moved = {} }) {
  const lines = readSource(repoRoot, source).split('\n');
  const fenced = fencedLines(lines);
  const starts = lines.flatMap((line, index) => (!fenced[index] && /^##\s+/.test(line) ? [index] : []));
  const intro = takeH1(lines.slice(0, starts[0] ?? lines.length).join('\n'));
  const skip = intro.body.trim() === '';
  const pages = [{ file: 'Introduction.md', title: introTitle, heading: intro.h1, body: intro.body, skip }];
  starts.forEach((start, n) => {
    const heading = lines[start].replace(/^##\s+/, '').trim();
    const body = lines.slice(start + 1, starts[n + 1] ?? lines.length).join('\n');
    pages.push({ file: `${normalizeFileStem(heading)}.md`, title: heading, heading, body });
  });
  if (pages.every((page) => page.skip)) {
    throw new Error(
      `sync-starlight: ${source} has no content to publish. Add a section or remove it from PLAN in docs/scripts/sync-starlight.mjs.`,
    );
  }
  return pages.map(({ file, body, ...page }) => ({
    ...page,
    source,
    target: `${moved[file] ?? to}/${file}`,
    body: body.trim(),
  }));
}

function collectPages(repoRoot, plan) {
  const pages = plan.flatMap((entry) => {
    if (entry.split) {
      return splitPages(repoRoot, entry);
    }
    if (entry.file) {
      return filePage(repoRoot, entry.file, entry.to);
    }
    const dir = path.join(repoRoot, entry.dir);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.md')) : [];
    if (files.length === 0) {
      throw new Error(
        `sync-starlight: no Markdown source in ${entry.dir}. Restore the directory or update PLAN in docs/scripts/sync-starlight.mjs.`,
      );
    }
    return files.flatMap((file) => filePage(repoRoot, `${entry.dir}/${file}`, `${entry.to}/${normalizeFileStem(file)}.md`));
  });
  const owner = new Map(handAuthored.map((target) => [target.toLowerCase(), 'a hand-authored page']));
  for (const page of pages.filter((candidate) => !candidate.skip)) {
    const key = page.target.toLowerCase();
    if (owner.has(key)) {
      throw new Error(
        `sync-starlight: ${page.source} ("${page.title}") and ${owner.get(key)} both generate ${contentDir}/${page.target}. Rename one of the headings or files.`,
      );
    }
    owner.set(key, `${page.source} ("${page.title}")`);
  }
  return pages;
}

function copyAssetDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyAssetDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(path.join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name],
    );
}

function prune(repoRoot, tree, keep) {
  const dir = path.join(repoRoot, tree);
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : undefined;
  if (real && real !== path.join(fs.realpathSync(repoRoot), tree)) {
    throw new Error(
      `sync-starlight: ${tree} is reached through a link (it resolves to ${real}), so it was not pruned: the files there may not belong to this repository. Replace the link, which is ${tree} or a directory above it, with a real directory.`,
    );
  }
  for (const file of listFiles(dir)) {
    if (!keep.has(file)) {
      fs.rmSync(path.join(repoRoot, tree, file));
      console.warn(
        `sync-starlight: removed ${tree}/${file}: nothing generates it (its source was deleted or renamed, or the file was made by hand). Commit the removal, restore the source, or write the content in a source file.`,
      );
    }
  }
}

export function sync(repoRoot, plan = PLAN) {
  const contentRoot = path.join(repoRoot, contentDir);
  const pages = collectPages(repoRoot, plan);
  const docs = indexSources(pages);
  const files = pages
    .filter((candidate) => !candidate.skip)
    .map((page) => {
      const body = rewriteLinks(page.body, (target, shown) => resolveLink(target, page, docs, repoRoot, shown));
      // JSON quoting is valid YAML and keeps a colon in the title from breaking the frontmatter.
      const frontmatter = page.frontmatter ?? `---\ntitle: ${JSON.stringify(page.title)}\n---\n\n`;
      return { target: page.target, content: `${frontmatter}${body}` };
    });
  const written = new Set(handAuthored);
  for (const { target, content } of files) {
    writeFile(path.join(contentRoot, target), content);
    written.add(target);
  }
  prune(repoRoot, contentDir, written);

  copyAssetDir(path.join(repoRoot, assets.from), path.join(repoRoot, assets.to));
  prune(repoRoot, assets.to, new Set(listFiles(path.join(repoRoot, assets.from))));

  fs.mkdirSync(contentRoot, { recursive: true });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  sync(path.resolve(import.meta.dirname, '..', '..'));
}
