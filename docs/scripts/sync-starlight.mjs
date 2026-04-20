import fs from 'node:fs';
import path from 'node:path';

const docsRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(docsRoot, '..');
const targetRoot = path.join(docsRoot, 'src', 'content', 'docs');
const docsBase = '/sample-autonomous-cloud-coding-agents';

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

function rewriteDocsLinkTarget(target) {
  if (!target || target.startsWith('#') || target.startsWith('/')) {
    return undefined;
  }
  if (/^[a-z]+:/i.test(target)) {
    return undefined;
  }

  const [pathPart, anchor] = target.split('#');
  if (!pathPart.toLowerCase().endsWith('.md')) {
    return undefined;
  }

  const normalizedPath = pathPart.replaceAll('\\', '/');
  const stem = path.basename(normalizedPath, '.md');
  const slug = normalizeFileStem(stem).toLowerCase();
  const anchorSuffix = anchor ? `#${anchor}` : '';

  const explicitGuideRoutes = {
    PROMPT_GUIDE: '/customizing/prompt-engineering',
    QUICK_START: '/getting-started/quick-start',
    ROADMAP: '/roadmap/roadmap',
    DEVELOPER_GUIDE: '/developer-guide/introduction',
    USER_GUIDE: '/using/overview',
    CONTRIBUTING: '/developer-guide/contributing',
  };

  /** `splitGuide` emits each `##` from DEVELOPER_GUIDE as its own page — map #anchors to those routes. */
  const developerGuideAnchorRoutes = {
    'repository-preparation': '/developer-guide/repository-preparation',
  };
  if (stem === 'DEVELOPER_GUIDE' && anchor) {
    const splitRoute = developerGuideAnchorRoutes[anchor.toLowerCase()];
    if (splitRoute) {
      return splitRoute;
    }
  }

  /** Map USER_GUIDE anchors to the new `using/` and `customizing/` directories. */
  const userGuideAnchorRoutes = {
    overview: '/using/overview',
    authentication: '/using/authentication',
    'repository-onboarding': '/customizing/repository-onboarding',
    'per-repo-overrides': '/customizing/per-repo-overrides',
    'task-types': '/using/task-types',
    'using-the-rest-api': '/using/using-the-rest-api',
    'using-the-cli': '/using/using-the-cli',
    'webhook-integration': '/using/webhook-integration',
    'task-lifecycle': '/using/task-lifecycle',
    'what-the-agent-does': '/using/what-the-agent-does',
    'tips-for-being-a-good-citizen': '/using/tips-for-being-a-good-citizen',
  };
  if (stem === 'USER_GUIDE' && anchor) {
    const splitRoute = userGuideAnchorRoutes[anchor.toLowerCase()];
    if (splitRoute) {
      return splitRoute;
    }
  }

  if (explicitGuideRoutes[stem]) {
    return `${explicitGuideRoutes[stem]}${anchorSuffix}`;
  }

  if (normalizedPath.includes('/guides/') || normalizedPath.startsWith('../guides/')) {
    return undefined;
  }
  return `/architecture/${slug}${anchorSuffix}`;
}

function ensureFrontmatter(content, title) {
  const normalized = content
    .replaceAll('../imgs/', `${docsBase}/imgs/`)
    .replaceAll('../diagrams/', `${docsBase}/diagrams/`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, target) => {
      const rewritten = rewriteDocsLinkTarget(target);
      return rewritten ? `[${label}](${rewritten})` : match;
    });

  const trimmed = normalized.trimStart();
  if (trimmed.startsWith('---')) {
    const closingIdx = trimmed.indexOf('\n---', 3);
    if (closingIdx !== -1) {
      return normalized;
    }
  }
  return `---\ntitle: ${title}\n---\n\n${normalized}`;
}

function writeFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.writeFileSync(targetPath, content, 'utf8');
  } catch (error) {
    // Some generated files can end up read-only in local environments.
    if (error && error.code === 'EACCES' && fs.existsSync(targetPath)) {
      fs.chmodSync(targetPath, 0o644);
      fs.writeFileSync(targetPath, content, 'utf8');
      return;
    }
    throw error;
  }
}

function mirrorMarkdownFile(sourcePath, targetRelativePath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const stem = path.basename(sourcePath, '.md');
  const fallbackTitle = normalizeFileStem(stem).replace(/-/g, ' ');
  const out = ensureFrontmatter(raw, fallbackTitle);
  writeFile(path.join(docsRoot, targetRelativePath), out);
}

function mirrorDirectory(sourceDir, targetDirRelative) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  const entries = fs.readdirSync(sourceDir);
  for (const file of entries) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const sourcePath = path.join(sourceDir, file);
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const fallbackTitle = normalizeFileStem(file).replace(/-/g, ' ');
    const out = ensureFrontmatter(raw, fallbackTitle);
    const normalizedName = `${normalizeFileStem(file)}.md`;
    writeFile(path.join(docsRoot, targetDirRelative, normalizedName), out);
  }
}

function splitGuide(sourcePath, targetDirRelative, introTitle) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parts = raw.split(/\n##\s+/g);
  const intro = parts.shift() ?? '';
  const introOut = ensureFrontmatter(intro.trim(), introTitle);
  writeFile(path.join(docsRoot, targetDirRelative, 'Introduction.md'), introOut);

  for (const part of parts) {
    const firstNewline = part.indexOf('\n');
    const heading = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1).trim();
    const filename = `${normalizeFileStem(heading)}.md`;
    const out = ensureFrontmatter(body, heading);
    writeFile(path.join(docsRoot, targetDirRelative, filename), out);
  }
}

// --- Developer Guide: split by ## into developer-guide/ ---
splitGuide(
  path.join(docsRoot, 'guides', 'DEVELOPER_GUIDE.md'),
  path.join('src', 'content', 'docs', 'developer-guide'),
  'Developer guide introduction',
);

// --- User Guide: split by ## into using/ ---
splitGuide(
  path.join(docsRoot, 'guides', 'USER_GUIDE.md'),
  path.join('src', 'content', 'docs', 'using'),
  'Using the platform',
);

// Move customization pages from using/ to customizing/ (they belong under the Customizing sidebar section)
const customizingPages = ['Repository-onboarding.md', 'Per-repo-overrides.md'];
for (const page of customizingPages) {
  const src = path.join(docsRoot, 'src', 'content', 'docs', 'using', page);
  const dest = path.join(docsRoot, 'src', 'content', 'docs', 'customizing', page);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }
}

// Remove orphaned stubs generated by splitGuide that have no useful content
const orphanedPages = ['Introduction.md', 'Prerequisites.md'];
for (const page of orphanedPages) {
  const filePath = path.join(docsRoot, 'src', 'content', 'docs', 'using', page);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- Quick Start: mirror to getting-started/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'QUICK_START.md'),
  path.join('src', 'content', 'docs', 'getting-started', 'Quick-start.md'),
);

// --- Prompt Guide: mirror to customizing/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'PROMPT_GUIDE.md'),
  path.join('src', 'content', 'docs', 'customizing', 'Prompt-engineering.md'),
);

// --- Roadmap: mirror to roadmap/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'ROADMAP.md'),
  path.join('src', 'content', 'docs', 'roadmap', 'Roadmap.md'),
);

// --- Contributing: mirror to developer-guide/ ---
mirrorMarkdownFile(
  path.join(repoRoot, 'CONTRIBUTING.md'),
  path.join('src', 'content', 'docs', 'developer-guide', 'Contributing.md'),
);

// --- Design docs: mirror to architecture/ ---
// Source lives at docs/design/ but renders at /architecture/ on the site.
// We keep the source directory named "design" because that's what CLAUDE.md and
// AGENTS.md reference for contributors. The rename happens only at the site level.
mirrorDirectory(path.join(docsRoot, 'design'), path.join('src', 'content', 'docs', 'architecture'));

// Guardrail: ensure target tree exists when running in a clean checkout.
fs.mkdirSync(targetRoot, { recursive: true });
