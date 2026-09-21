import fs from 'node:fs';
import path from 'node:path';

const docsRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(docsRoot, '..');
const targetRoot = path.join(docsRoot, 'src', 'content', 'docs');
const docsBase = '/sample-autonomous-cloud-coding-agents';

function normalizeFileStem(input) {
  const cleaned = input
    .replace(/\.mdx?$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!cleaned) {
    return 'Untitled';
  }
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function rewriteDocsLinkTarget(target, sourcePath) {
  if (target?.startsWith('#') && path.basename(sourcePath) === 'USER_GUIDE.md') {
    const route = {
      '#joining-an-existing-deployment': '/using/authentication#joining-an-existing-deployment',
      '#get-stack-outputs': '/using/authentication#get-stack-outputs',
      '#approval-gates-cedar-hitl': '/using/approval-gates-cedar-hitl',
    }[target];
    if (route) return route;
  }
  if (!target || target.startsWith('#') || target.startsWith('/')) {
    return undefined;
  }
  if (/^[a-z]+:/i.test(target)) {
    return undefined;
  }

  const [pathPart, anchor] = target.split('#');

  const normalizedPath = pathPart.replaceAll('\\', '/');
  // Resolve relative links in the source tree before assigning a site route.
  // In particular, ./README.md inside verification is not architecture/readme.
  const sourceTarget = path.resolve(path.dirname(sourcePath), normalizedPath);
  if (sourceTarget === path.join(targetRoot, 'index.md')) return '/';
  if (sourceTarget === path.join(docsRoot, 'decisions')) return '/decisions/readme';
  const relativeSource = path.relative(repoRoot, sourceTarget).replaceAll('\\', '/');
  if (!relativeSource.startsWith('../') && fs.existsSync(sourceTarget)
    && (!sourceTarget.startsWith(docsRoot + path.sep) || sourceTarget === path.join(docsRoot, 'README.md')
      || sourceTarget.startsWith(path.join(docsRoot, 'abca-plugin') + path.sep))) {
    const kind = fs.statSync(sourceTarget).isDirectory() ? 'tree' : 'blob';
    return `https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/${kind}/main/${relativeSource}${anchor ? `#${anchor}` : ''}`;
  }
  if (!/\.mdx?$/i.test(pathPart)) return undefined;
  for (const directory of ['verification', 'decisions']) {
    if (path.dirname(sourceTarget) === path.join(docsRoot, directory)) {
      const slug = normalizeFileStem(path.basename(sourceTarget)).toLowerCase();
      return `/${directory}/${slug}${anchor ? `#${anchor}` : ''}`;
    }
  }
  const stem = path.basename(normalizedPath).replace(/\.mdx?$/i, '');
  const slug = normalizeFileStem(stem).toLowerCase();
  const anchorSuffix = anchor ? `#${anchor}` : '';

  const explicitGuideRoutes = {
    PROMPT_GUIDE: '/customizing/prompt-engineering',
    QUICK_START: '/getting-started/quick-start',
    DEVELOPER_GUIDE: '/developer-guide/introduction',
    USER_GUIDE: '/using/overview',
    CONTRIBUTING: '/developer-guide/contributing',
    SLACK_SETUP_GUIDE: '/using/slack-setup-guide',
    LINEAR_SETUP_GUIDE: '/using/linear-setup-guide',
    JIRA_SETUP_GUIDE: '/using/jira-setup-guide',
    DEPLOY_PREVIEW_SCREENSHOTS_GUIDE: '/using/deploy-preview-screenshots-guide',
    CEDAR_POLICY_GUIDE: '/customizing/cedar-policies',
    DEPLOYMENT_GUIDE: '/getting-started/deployment-guide',
    // Mirrored to getting-started/Cost-attribution.md (see the copy list below), NOT
    // architecture/. Without this entry a relative `./COST_ATTRIBUTION.md` link misses
    // the `/guides/` bail-out and falls through to the `/architecture/${slug}` default,
    // producing a 404 on the published site.
    COST_ATTRIBUTION: '/getting-started/cost-attribution',
  };

  /** `splitGuide` emits each `##` from DEVELOPER_GUIDE as its own page — map #anchors to those routes. */
  const developerGuideAnchorRoutes = {
    'repository-preparation': '/developer-guide/repository-preparation',
    'model-configuration': '/developer-guide/model-configuration',
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
    'joining-an-existing-deployment': '/using/authentication#joining-an-existing-deployment',
    'get-stack-outputs': '/using/authentication#get-stack-outputs',
    'operator-commands-stack-admin': '/using/using-the-cli#operator-commands-stack-admin',
    'repository-onboarding': '/customizing/repository-onboarding',
    'per-repo-overrides': '/customizing/per-repo-overrides',
    'monthly-user-and-team-budgets': '/customizing/per-repo-overrides#monthly-user-and-team-budgets',
    workflows: '/using/workflows',
    'using-the-rest-api': '/using/using-the-rest-api',
    'using-the-cli': '/using/using-the-cli',
    'webhook-integration': '/using/webhook-integration',
    'task-lifecycle': '/using/task-lifecycle',
    'what-the-agent-does': '/using/what-the-agent-does',
    'approval-gates-cedar-hitl': '/using/approval-gates-cedar-hitl',
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

function ensureFrontmatter(content, title, sourcePath) {
  const normalized = content
    .replaceAll('../imgs/', `${docsBase}/imgs/`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, target) => {
      const rewritten = rewriteDocsLinkTarget(target, sourcePath);
      if (!rewritten) {
        return match;
      }
      // The site is served under `base` (docsBase), so root-relative routes
      // must carry that prefix — otherwise they resolve to the domain root
      // and 404. Starlight prefixes its own nav links automatically, but our
      // rewritten body links are raw markdown and need it added explicitly
      // Repository-only documents instead retain their absolute GitHub URL.
      return `[${label}](${rewritten.startsWith('/') ? docsBase : ''}${rewritten})`;
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
  const ext = path.extname(sourcePath);
  const stem = path.basename(sourcePath, ext);
  const fallbackTitle = normalizeFileStem(stem).replace(/-/g, ' ');
  const out = ensureFrontmatter(raw, fallbackTitle, sourcePath);
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
    const out = ensureFrontmatter(raw, fallbackTitle, sourcePath);
    const normalizedName = `${normalizeFileStem(file)}.md`;
    writeFile(path.join(docsRoot, targetDirRelative, normalizedName), out);
  }
}

// Recursively copy a source asset directory into the site's public/ tree so
// every committed image/diagram is served at its rewritten absolute URL.
// Filenames are preserved verbatim (markdown references them as-is).
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

function splitGuide(sourcePath, targetDirRelative, introTitle) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parts = raw.split(/\n##\s+/g);
  const intro = parts.shift() ?? '';
  const introOut = ensureFrontmatter(intro.trim(), introTitle, sourcePath);
  writeFile(path.join(docsRoot, targetDirRelative, 'Introduction.md'), introOut);

  for (const part of parts) {
    const firstNewline = part.indexOf('\n');
    const heading = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1).trim();
    const filename = `${normalizeFileStem(heading)}.md`;
    const out = ensureFrontmatter(body, heading, sourcePath);
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
const orphanedPages = ['Introduction.md', 'Prerequisites.md', 'Task-types.md'];
for (const page of orphanedPages) {
  const filePath = path.join(docsRoot, 'src', 'content', 'docs', 'using', page);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- Quick Start: mirror to getting-started/ (MDX for Starlight Tabs) ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'QUICK_START.mdx'),
  path.join('src', 'content', 'docs', 'getting-started', 'Quick-start.mdx'),
);

// --- Deployment Guide: mirror to getting-started/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'DEPLOYMENT_GUIDE.md'),
  path.join('src', 'content', 'docs', 'getting-started', 'Deployment-guide.md'),
);

// --- Cost Attribution Guide: mirror to getting-started/ (operator FinOps setup) ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'COST_ATTRIBUTION.md'),
  path.join('src', 'content', 'docs', 'getting-started', 'Cost-attribution.md'),
);

// --- Prompt Guide: mirror to customizing/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'PROMPT_GUIDE.md'),
  path.join('src', 'content', 'docs', 'customizing', 'Prompt-engineering.md'),
);

// --- Slack Setup Guide: mirror to using/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'SLACK_SETUP_GUIDE.md'),
  path.join('src', 'content', 'docs', 'using', 'Slack-setup-guide.md'),
);

// --- Linear Setup Guide: mirror to using/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'LINEAR_SETUP_GUIDE.md'),
  path.join('src', 'content', 'docs', 'using', 'Linear-setup-guide.md'),
);

// --- Jira Setup Guide: mirror to using/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'JIRA_SETUP_GUIDE.md'),
  path.join('src', 'content', 'docs', 'using', 'Jira-setup-guide.md'),
);

// --- Deploy preview screenshots guide: mirror to using/ ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'DEPLOY_PREVIEW_SCREENSHOTS_GUIDE.md'),
  path.join('src', 'content', 'docs', 'using', 'Deploy-preview-screenshots-guide.md'),
);

// --- Cedar Policy Guide: mirror to customizing/ (authoring reference for blueprint authors) ---
mirrorMarkdownFile(
  path.join(docsRoot, 'guides', 'CEDAR_POLICY_GUIDE.md'),
  path.join('src', 'content', 'docs', 'customizing', 'Cedar-policies.md'),
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

// --- Decision records (ADRs): mirror to decisions/ ---
mirrorDirectory(path.join(docsRoot, 'decisions'), path.join('src', 'content', 'docs', 'decisions'));

// Verification runbooks ship with the same revision as their referring pages.
mirrorDirectory(path.join(docsRoot, 'verification'), path.join('src', 'content', 'docs', 'verification'));

// --- Static assets: copy source image dir into the site's public/ ---
// Guides reference images as `../imgs/foo.png`; ensureFrontmatter() turns
// those into absolute `/<base>/imgs/foo.png` URLs, which Astro serves from
// public/. Copy the source dir here so every committed image is published —
// otherwise a new image lands in docs/imgs/ but 404s on the site (#90).
copyAssetDir(path.join(docsRoot, 'imgs'), path.join(docsRoot, 'public', 'imgs'));

// Guardrail: ensure target tree exists when running in a clean checkout.
fs.mkdirSync(targetRoot, { recursive: true });
