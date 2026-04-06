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
    PROMPT_GUIDE: '/user-guide/prompt-guide',
    ROADMAP: '/roadmap/roadmap',
    DEVELOPER_GUIDE: '/developer-guide/introduction',
    USER_GUIDE: '/user-guide/introduction',
    CONTRIBUTING: '/developer-guide/contributing',
  };

  if (explicitGuideRoutes[stem]) {
    return `${explicitGuideRoutes[stem]}${anchorSuffix}`;
  }

  if (normalizedPath.includes('/guides/') || normalizedPath.startsWith('../guides/')) {
    return undefined;
  }
  return `/design/${slug}${anchorSuffix}`;
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

splitGuide(
  path.join(docsRoot, 'guides', 'DEVELOPER_GUIDE.md'),
  path.join('src', 'content', 'docs', 'developer-guide'),
  'Developer guide introduction',
);
splitGuide(
  path.join(docsRoot, 'guides', 'USER_GUIDE.md'),
  path.join('src', 'content', 'docs', 'user-guide'),
  'User guide introduction',
);
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'PROMPT_GUIDE.md'),
  path.join('src', 'content', 'docs', 'user-guide', 'Prompt-guide.md'),
);
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'ROADMAP.md'),
  path.join('src', 'content', 'docs', 'roadmap', 'Roadmap.md'),
);
mirrorMarkdownFile(
  path.join(repoRoot, 'CONTRIBUTING.md'),
  path.join('src', 'content', 'docs', 'developer-guide', 'Contributing.md'),
);
mirrorDirectory(path.join(docsRoot, 'design'), path.join('src', 'content', 'docs', 'design'));

// Guardrail: ensure target tree exists when running in a clean checkout.
fs.mkdirSync(targetRoot, { recursive: true });
