/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { awscdk, javascript, typescript, TextFile } from 'projen';
import { GithubWorkflow } from 'projen/lib/github/workflows';
import { JobPermission } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';
const CDK_VERSION: string = '2.238.0';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: CDK_VERSION,
  projenVersion: '~0.99.26',
  constructsVersion: '10.3.0',
  defaultReleaseBranch: 'main',
  name: 'abca',
  projenrcTs: true,
  description: 'Sample Autonomous Background Cloud Coding Agents platform on AWS',
  devDeps: [
    '@cdklabs/eslint-plugin',
    'eslint-plugin-jsdoc',
    'eslint-plugin-jest',
    'typedoc',
    'typedoc-plugin-markdown',
    'eslint-plugin-license-header',
    '@types/aws-lambda',
    'retire',
  ],
  deps: [
    `@aws-cdk/aws-bedrock-alpha@${CDK_VERSION}-alpha.0`,
    `@aws-cdk/mixins-preview@${CDK_VERSION}-alpha.0`,
    `@aws-cdk/aws-bedrock-agentcore-alpha@${CDK_VERSION}-alpha.0`,
    'cdk-nag',
    'ulid',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/lib-dynamodb',
    '@aws-sdk/client-lambda',
    '@aws-sdk/client-bedrock-agentcore',
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-secrets-manager',
    '@aws/durable-execution-sdk-js',
  ],
  stability: 'experimental',
  sampleCode: false,
  docgen: false,
  minNodeVersion: '20.x', // 'MAINTENANCE' (first LTS)
  maxNodeVersion: '24.x', // 'CURRENT'
  workflowNodeVersion: '22.x', // 'ACTIVE'
  release: false,
  github: true,
  licensed: true,
  license: 'MIT-0',
  copyrightPeriod: '2026-',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  workflowBootstrapSteps: [
    {
      name: 'Install mise',
      uses: 'jdx/mise-action@v3.6.2',
      with: {
        cache: true,
      },
    },
  ],
  buildWorkflowOptions: {
    env: {
      GITHUB_TOKEN: '${{ secrets.PROJEN_GITHUB_TOKEN || github.token }}',
    },
  },
  gitignore: [
    '*.DS_STORE',
    '!.node-version',
    '*.pyc',
    '__pycache__/',
    '!.ort.yml',
    '.idea',
    '.vscode',
    'cdk.context.json',
    '*.bkp',
    'gitleaks-*.json',
    'agent/gitleaks-report.json',
    '.claude/settings.local.json',
  ],
});

/**
 * Apply shared ESLint rules to a project (non-CDK-specific).
 * CDK rules (@cdklabs/*) are added only to the root project separately.
 *
 * @param proj - The project to configure.
 * @param headerPath - Relative path to the license header file.
 */
function applySharedEslintRules(proj: TypeScriptProject, headerPath: string): void {
  proj.eslint?.addPlugins('license-header', 'jsdoc', 'jest');
  proj.eslint?.addRules({
    'license-header/header': ['error', headerPath],

    // Error handling
    'no-throw-literal': ['error'],

    '@stylistic/indent': ['error', 2],

    // Style
    'quotes': ['error', 'single', { avoidEscape: true }],
    '@stylistic/member-delimiter-style': ['error'], // require semicolon delimiter
    '@stylistic/comma-dangle': ['error', 'always-multiline'], // ensures clean diffs, see https://medium.com/@nikgraf/why-you-should-enforce-dangling-commas-for-multiline-statements-d034c98e36f8
    '@stylistic/no-extra-semi': ['error'], // no extra semicolons
    'comma-spacing': ['error', { before: false, after: true }], // space after, no space before
    'no-multi-spaces': ['error', { ignoreEOLComments: false }], // no multi spaces
    'array-bracket-spacing': ['error', 'never'], // [1, 2, 3]
    'array-bracket-newline': ['error', 'consistent'], // enforce consistent line breaks between brackets
    'object-curly-spacing': ['error', 'always'], // { key: 'value' }
    'object-curly-newline': ['error', { multiline: true, consistent: true }], // enforce consistent line breaks between braces
    'object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }], // enforce "same line" or "multiple line" on object properties
    'keyword-spacing': ['error'], // require a space before & after keywords
    'brace-style': ['error', '1tbs', { allowSingleLine: true }], // enforce one true brace style
    'space-before-blocks': 'error', // require space before blocks
    'curly': ['error', 'multi-line', 'consistent'], // require curly braces for multiline control statements
    'eol-last': ['error', 'always'], // require a newline a the end of files
    '@stylistic/spaced-comment': ['error', 'always', { exceptions: ['/', '*'], markers: ['/'] }], // require a whitespace at the beginninng of each comment
    '@stylistic/padded-blocks': ['error', { classes: 'never', blocks: 'never', switches: 'never' }],
    // JSDoc
    'jsdoc/require-param-description': ['error'],
    'jsdoc/require-property-description': ['error'],
    'jsdoc/require-returns-description': ['error'],
    'jsdoc/check-alignment': ['error'],
    // Require all imported libraries actually resolve (!!required for import/no-extraneous-dependencies to work!!)
    'import/no-unresolved': ['error'],
    // Require an ordering on all imports
    'import/order': ['error', {
      groups: ['builtin', 'external'],
      alphabetize: { order: 'asc', caseInsensitive: true },
    }],
    // Cannot import from the same module twice
    'no-duplicate-imports': ['error'],

    // Cannot shadow names
    'no-shadow': ['off'],
    // Required spacing in property declarations (copied from TSLint, defaults are good)
    'key-spacing': ['error'],

    // Require semicolons
    'semi': ['error', 'always'],

    // Don't unnecessarily quote properties
    'quote-props': ['error', 'consistent-as-needed'],

    // No multiple empty lines
    'no-multiple-empty-lines': ['error', { max: 1 }],
    // Max line lengths
    'max-len': ['error', {
      code: 150,
      ignoreUrls: true, // Most common reason to disable it
      ignoreStrings: true, // These are not fantastic but necessary for error messages
      ignoreTemplateLiterals: true,
      ignoreComments: true,
      ignoreRegExpLiterals: true,
    }],
    // One of the easiest mistakes to make
    '@typescript-eslint/no-floating-promises': ['error'],

    // Make sure that inside try/catch blocks, promises are 'return await'ed
    // (must disable the base rule as it can report incorrect errors)
    'no-return-await': 'off',
    '@typescript-eslint/return-await': 'error',
    // Don't leave log statements littering the premises!
    'no-console': ['error'],

    // Useless diff results
    'no-trailing-spaces': ['error'],

    // Must use foo.bar instead of foo['bar'] if possible
    'dot-notation': ['error'],
    // Are you sure | is not a typo for || ?
    'no-bitwise': ['error'],
    // No more md5, will break in FIPS environments
    'no-restricted-syntax': [
      'error',
      {
        // Both qualified and unqualified calls
        selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
        message: 'Use the md5hash() function from the core library if you want md5',
      },
    ],
    // Member ordering
    '@typescript-eslint/member-ordering': ['error', {
      default: [
        'public-static-field',
        'public-static-method',
        'protected-static-field',
        'protected-static-method',
        'private-static-field',
        'private-static-method',

        'field',

        // Constructors
        'constructor', // = ["public-constructor", "protected-constructor", "private-constructor"]

        // Methods
        'method',
      ],
    }],
    // Too easy to make mistakes
    '@typescript-eslint/unbound-method': 'error',
    // Overrides for plugin:jest/recommended
    'jest/expect-expect': 'off',
    'jest/no-conditional-expect': 'off',
    'jest/no-done-callback': 'off', // Far too many of these in the codebase.
    'jest/no-standalone-expect': 'off', // nodeunitShim confuses this check.
    'jest/valid-expect': 'off', // expect from '@aws-cdk/assert' can take a second argument
    'jest/valid-title': 'off', // A little over-zealous with test('test foo') being an error.
    'jest/no-identical-title': 'off', // TEMPORARY - Disabling this until https://github.com/jest-community/eslint-plugin-jest/issues/836 is resolved
    'jest/no-disabled-tests': 'error', // Skipped tests are easily missed in PR reviews
    'jest/no-focused-tests': 'error', // Focused tests are easily missed in PR reviews
  });
}

// Root project: CDK-specific ESLint rules (not shared with CLI)
project.eslint?.addPlugins('@cdklabs/eslint-plugin');
project.eslint?.addRules({
  '@cdklabs/no-core-construct': ['error'],
  '@cdklabs/invalid-cfn-imports': ['error'],
  '@cdklabs/no-literal-partition': ['error'],
  '@cdklabs/no-invalid-path': ['error'],
  '@cdklabs/promiseall-no-unbounded-parallelism': ['error'],
});

// Root project: shared ESLint rules
applySharedEslintRules(project, 'header.js');

// ---------------------------------------------------------------------------
// CLI subproject
// ---------------------------------------------------------------------------
const cli = new typescript.TypeScriptProject({
  parent: project,
  outdir: 'cli',
  name: '@abca/cli',
  defaultReleaseBranch: 'main',
  eslint: true,
  jest: true,
  sampleCode: false,
  licensed: true,
  license: 'MIT-0',
  copyrightPeriod: '2026-',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  depsUpgrade: true,
  depsUpgradeOptions: {
    workflow: false,
    target: 'minor',
  },
  deps: [
    'commander',
    '@aws-sdk/client-cognito-identity-provider',
  ],
  devDeps: [
    'eslint-plugin-jsdoc',
    'eslint-plugin-jest',
    'eslint-plugin-license-header',
    'retire',
  ],
  bin: {
    bgagent: 'lib/bin/bgagent.js',
  },
  scripts: {
    'security:retire': 'retire --path . --severity high',
  },
});

// CLI: shared ESLint rules (no @cdklabs rules)
applySharedEslintRules(cli, 'header.js');

// CLI: console output IS the product — disable no-console
cli.eslint?.addOverride({
  files: ['src/**/*.ts'],
  rules: { 'no-console': 'off' },
});

// CLI: license header file (eslint-plugin-license-header resolves relative to CWD)
new TextFile(cli, 'header.js', {
  marker: false,
  lines: [
    '/**',
    ' *  MIT No Attribution',
    ' *',
    ' *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.',
    ' *',
    ' *  Permission is hereby granted, free of charge, to any person obtaining a copy of',
    ' *  the Software without restriction, including without limitation the rights to',
    ' *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of',
    ' *  the Software, and to permit persons to whom the Software is furnished to do so.',
    ' *',
    ' *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    ' *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    ' *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    ' *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    ' *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    ' *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    ' *  SOFTWARE.',
    ' */',
    '',
  ],
});

// eslint-plugin-import@2.x uses babel interop default import for minimatch; hoisting
// minimatch@9 (from glob, etc.) breaks import/no-extraneous-dependencies at load time.
project.package.addField('resolutions', {
  'eslint-plugin-import/minimatch': '^3.1.2',
});
cli.package.addField('resolutions', {
  'eslint-plugin-import/minimatch': '^3.1.2',
});

// Hook CLI build into the root build pipeline so CI covers both projects
project.postCompileTask.exec('cd cli && npx projen build');

// ---------------------------------------------------------------------------
// Docs site subproject (Astro + Starlight)
// ---------------------------------------------------------------------------
/** GitHub Pages project segment; must match Astro `base` and public asset URLs in mirrored markdown. */
const DOCS_ASTRO_BASE = '/sample-autonomous-cloud-coding-agents';

const docsSite = new javascript.NodeProject({
  parent: project,
  outdir: 'docs',
  name: '@abca/docs',
  defaultReleaseBranch: 'main',
  licensed: true,
  license: 'MIT-0',
  copyrightPeriod: '2026-',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  depsUpgrade: true,
  depsUpgradeOptions: {
    workflow: false,
    target: 'minor',
  },
  deps: [
    'astro',
    '@astrojs/starlight',
    '@astrojs/check',
    'typescript',
  ],
  scripts: {
    'dev': 'astro dev',
    'start': 'astro dev',
    'docs:build': 'astro check && astro build',
    'docs:check': 'astro check',
    'security:retire': 'retire --path . --severity high',
    'preview': 'astro preview',
  },
  devDeps: [
    'retire',
  ],
});
docsSite.gitignore.addPatterns('.astro/', 'dist/');

new TextFile(docsSite, 'astro.config.mjs', {
  marker: false,
  lines: [
    "import { defineConfig } from 'astro/config';",
    "import starlight from '@astrojs/starlight';",
    '',
    'export default defineConfig({',
    "  site: 'https://aws-samples.github.io',",
    `  base: '${DOCS_ASTRO_BASE}',`,
    '  integrations: [',
    '    starlight({',
    "      title: 'ABCA Docs',",
    '      head: [',
    '        {',
    "          tag: 'script',",
    '          content:',
    "            \"(function(){try{if(typeof localStorage!=='undefined'){var k='starlight-theme';if(localStorage.getItem(k)===null)localStorage.setItem(k,'dark');}}catch(e){}})();\",",
    '        },',
    '      ],',
    '      sidebar: [',
    "        { label: 'Introduction', slug: 'index' },",
    '        {',
    "          label: 'Developer Guide',",
    '          items: [',
    "            { slug: 'developer-guide/introduction' },",
    "            { slug: 'developer-guide/installation' },",
    "            { slug: 'developer-guide/repository-preparation' },",
    "            { slug: 'developer-guide/project-structure' },",
    "            { slug: 'developer-guide/contributing' },",
    '          ],',
    '        },',
    '        {',
    "          label: 'User Guide',",
    '          items: [',
    "            { slug: 'user-guide/introduction' },",
    "            { slug: 'user-guide/overview' },",
    "            { slug: 'user-guide/prerequisites' },",
    "            { slug: 'user-guide/authentication' },",
    "            { slug: 'user-guide/repository-onboarding' },",
    "            { slug: 'user-guide/using-the-rest-api' },",
    "            { slug: 'user-guide/using-the-cli' },",
    "            { slug: 'user-guide/webhook-integration' },",
    "            { slug: 'user-guide/task-lifecycle' },",
    "            { slug: 'user-guide/what-the-agent-does' },",
    "            { slug: 'user-guide/viewing-logs' },",
    "            { slug: 'user-guide/tips' },",
    "            { label: 'Prompt guide', slug: 'user-guide/prompt-guide' },",
    '          ],',
    '        },',
    '        {',
    "          label: 'Roadmap',",
    "          autogenerate: { directory: 'roadmap' },",
    '        },',
    "        { label: 'Design', autogenerate: { directory: 'design' } },",
    '      ],',
    '    }),',
    '  ],',
    '});',
    '',
  ],
});

new TextFile(docsSite, 'tsconfig.json', {
  marker: false,
  lines: [
    '{',
    '  "extends": "astro/tsconfigs/strict",',
    '  "include": [".astro/types.d.ts", "**/*"],',
    '  "exclude": ["dist"]',
    '}',
    '',
  ],
});

new TextFile(docsSite, 'src/content.config.ts', {
  marker: false,
  lines: [
    "import { defineCollection } from 'astro:content';",
    "import { docsLoader } from '@astrojs/starlight/loaders';",
    "import { docsSchema } from '@astrojs/starlight/schema';",
    '',
    'const docs = defineCollection({',
    '  loader: docsLoader(),',
    '  schema: docsSchema(),',
    '});',
    '',
    'export const collections = { docs };',
    '',
  ],
});

new TextFile(docsSite, 'src/content/docs/index.md', {
  marker: false,
  lines: [
    '---',
    'title: Introduction',
    'description: ABCA — Autonomous Background Coding Agents on AWS.',
    '---',
    '',
    '# ABCA',
    '',
    '',
    '**Autonomous Background Coding Agents on AWS**',
    '',
    '',
    '## What is ABCA',
    '',
    '**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted background coding agents platform might look like on AWS. Users can create background coding agents, then submit coding tasks to them and the agents work autonomously in the cloud — cloning repos, writing code, running tests, and opening pull requests for review. No human interaction during execution.',
    '',
    'The platform is built on AWS CDK with a modular architecture: an input gateway normalizes requests from any channel, a durable orchestrator executes each task according to a blueprint, and isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory, and a review feedback loop captures PR review comments to improve future runs.',
    '',
    '## The use case',
    '',
    'Users submit tasks through webhooks, CLI, or Slack. For each task, the orchestrator executes the blueprint: an isolated environment is provisioned, an agent clones the target GitHub repository, creates a branch, works on the task, and opens a pull request.',
    '',
    'Key characteristics:',
    '',
    '- **Ephemeral environments** — each task starts fresh, no in-process state carries over',
    '- **Asynchronous** — no real-time conversation during execution',
    '- **Repository-scoped** — each task targets a specific repo',
    '- **Outcome-measurable** — the PR is either merged, revised, or rejected',
    '- **Fire and forget** — submit, forget, review the outcome',
    '- **Learns over time** — the more you use it, the more it self-improves',
    '',
    '## How it works',
    '',
    'Each task follows a **blueprint** — a hybrid workflow that mixes deterministic steps (no LLM, predictable, cheap) with agentic steps (LLM-driven, flexible, expensive):',
    '',
    '1. **Admission** — the orchestrator validates the request, checks concurrency limits, and queues the task if needed.',
    '2. **Context hydration** — the platform gathers context: task description, GitHub issue body, repo-intrinsic knowledge (CLAUDE.md, README), and memory from past tasks on the same repo.',
    '3. **Agent execution** — the agent runs in an isolated MicroVM: clones the repo, creates a branch, edits code, commits, runs tests and lint. The orchestrator polls for completion without blocking compute.',
    '4. **Finalization** — the orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.',
    '',
    '',
  ],
});

/**
 * Ensure markdown has frontmatter so Starlight can index it reliably.
 *
 * @param content - Markdown content.
 * @param title - Fallback title.
 * @returns Markdown content with frontmatter.
 */
function ensureFrontmatter(content: string, title: string): string {
  const normalizedContent = content
    .replaceAll('../imgs/', `${DOCS_ASTRO_BASE}/imgs/`)
    .replaceAll('../diagrams/', `${DOCS_ASTRO_BASE}/diagrams/`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match: string, label: string, target: string) => {
      const rewritten = rewriteDocsLinkTarget(target);
      return rewritten ? `[${label}](${rewritten})` : match;
    });
  const trimmed = content.trimStart();
  if (trimmed.startsWith('---')) {
    const closingIdx = trimmed.indexOf('\n---', 3);
    if (closingIdx !== -1) {
      return normalizedContent;
    }
  }
  return `---\ntitle: ${title}\n---\n\n${normalizedContent}`;
}

/**
 * Rewrite relative markdown links to docs-site routes while preserving raw markdown source links.
 *
 * @param target - Link target from markdown.
 * @returns Rewritten docs-site path or undefined when no rewrite applies.
 */
function rewriteDocsLinkTarget(target: string): string | undefined {
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

  const explicitGuideRoutes: Record<string, string> = {
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

/**
 * Convert arbitrary text into normalized file-name stem.
 *
 * Rule: first letter uppercase, all remaining letters lowercase.
 *
 * @param input - Raw title or filename stem.
 * @returns Normalized filename stem.
 */
function normalizeFileStem(input: string): string {
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

/**
 * Create docs files from a source directory.
 *
 * @param sourceDir - Absolute source directory.
 * @param targetDir - Target directory under src/content/docs.
 */
function mirrorDirectory(sourceDir: string, targetDir: string): void {
  const entries = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : [];
  for (const file of entries) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const sourcePath = path.join(sourceDir, file);
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const fallbackTitle = normalizeFileStem(file).replace(/-/g, ' ');
    const content = ensureFrontmatter(raw, fallbackTitle);
    const normalizedName = `${normalizeFileStem(file)}.md`;
    new TextFile(docsSite, `${targetDir}/${normalizedName}`, {
      marker: false,
      lines: content.split('\n'),
    });
  }
}

/**
 * Copy a single markdown file into Starlight content.
 *
 * @param sourcePath - Absolute path to source file.
 * @param targetRelativePath - Path under docs site (e.g. src/content/docs/developer-guide/Contributing.md).
 */
function mirrorMarkdownFile(sourcePath: string, targetRelativePath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const stem = path.basename(sourcePath, '.md');
  const fallbackTitle = normalizeFileStem(stem).replace(/-/g, ' ');
  const content = ensureFrontmatter(raw, fallbackTitle);
  new TextFile(docsSite, targetRelativePath, {
    marker: false,
    lines: content.split('\n'),
  });
}

/**
 * Split a monolithic guide into one intro document and section documents.
 *
 * @param sourcePath - Absolute path to the monolithic markdown file.
 * @param targetDir - Target directory under src/content/docs.
 * @param introTitle - Title to use for the intro page.
 */
function splitGuide(sourcePath: string, targetDir: string, introTitle: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parts = raw.split(/\n##\s+/g);
  const intro = parts.shift() ?? '';
  const introContent = ensureFrontmatter(intro.trim(), introTitle);
  new TextFile(docsSite, `${targetDir}/Introduction.md`, {
    marker: false,
    lines: introContent.split('\n'),
  });

  for (const part of parts) {
    const firstNewline = part.indexOf('\n');
    const heading = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1).trim();
    const filename = `${normalizeFileStem(heading)}.md`;
    const sectionContent = ensureFrontmatter(body, heading);
    new TextFile(docsSite, `${targetDir}/${filename}`, {
      marker: false,
      lines: sectionContent.split('\n'),
    });
  }
}

splitGuide(
  path.join(__dirname, 'docs', 'guides', 'DEVELOPER_GUIDE.md'),
  'src/content/docs/developer-guide',
  'Developer guide introduction',
);
splitGuide(
  path.join(__dirname, 'docs', 'guides', 'USER_GUIDE.md'),
  'src/content/docs/user-guide',
  'User guide introduction',
);
mirrorMarkdownFile(
  path.join(__dirname, 'docs', 'guides', 'PROMPT_GUIDE.md'),
  'src/content/docs/user-guide/Prompt-guide.md',
);
mirrorMarkdownFile(
  path.join(__dirname, 'docs', 'guides', 'ROADMAP.md'),
  'src/content/docs/roadmap/Roadmap.md',
);
mirrorDirectory(path.join(__dirname, 'docs', 'design'), 'src/content/docs/design');
mirrorMarkdownFile(path.join(__dirname, 'CONTRIBUTING.md'), 'src/content/docs/developer-guide/Contributing.md');

/**
 * Copy a binary asset into the docs site `public/` tree (served at the site root).
 */
function copyDocsPublicAsset(sourceAbsolute: string, destRelativeToDocs: string): void {
  if (!fs.existsSync(sourceAbsolute)) {
    return;
  }
  const dest = path.join(__dirname, 'docs', destRelativeToDocs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(sourceAbsolute, dest);
}

function copyDocsPublicDirectory(sourceDirAbsolute: string, destDirRelativeToDocs: string): void {
  if (!fs.existsSync(sourceDirAbsolute)) {
    return;
  }
  const entries = fs.readdirSync(sourceDirAbsolute, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDirAbsolute, entry.name);
    const destPath = path.join(destDirRelativeToDocs, entry.name);
    if (entry.isDirectory()) {
      copyDocsPublicDirectory(sourcePath, destPath);
      continue;
    }
    copyDocsPublicAsset(sourcePath, destPath);
  }
}

copyDocsPublicDirectory(path.join(__dirname, 'docs', 'imgs'), 'public/imgs');

// Hook docs site build into root build pipeline so CI covers docs rendering
project.postCompileTask.exec('cd docs && npm run docs:build');

// ---------------------------------------------------------------------------
// Agent (Python) tasks — delegates to mise in agent/
// ---------------------------------------------------------------------------
const agentInstall = project.addTask('agent:install', {
  description: 'Install agent Python dependencies via mise',
  cwd: 'agent',
  exec: 'mise run install',
});
project.tasks.tryFind('install')?.spawn(agentInstall);

const agentCheck = project.addTask('agent:check', {
  description: 'Run all agent checks (install, quality, security)',
  cwd: 'agent',
  steps: [
    {
      exec: 'mise run install',
    },
    {
      exec: 'mise run quality',
    },
    {
      exec: 'mise run security',
    },
  ],
});

const retireCheck = project.addTask('security:retire', {
  description: 'Run Retire.js scans for root, CLI, and docs',
  steps: [
    {
      exec: 'npx retire --path . --severity high --ignore "node_modules/**,cdk.out/**,agent/**,cli/**,docs/**"',
    },
    {
      exec: 'cd cli && npm run security:retire',
    },
    {
      exec: 'cd docs && npm run security:retire',
    },
  ],
});

project.postCompileTask.spawn(agentCheck);
project.postCompileTask.spawn(retireCheck);

// ---------------------------------------------------------------------------
// GitHub Actions — build and deploy Starlight docs to GitHub Pages
// ---------------------------------------------------------------------------
const gitHub = project.github;
if (gitHub) {
  const docsPagesWorkflow = new GithubWorkflow(gitHub, 'Documentation', {
    fileName: 'docs.yml',
    limitConcurrency: true,
    concurrencyOptions: {
      group: 'pages',
      cancelInProgress: true,
    },
  });
  docsPagesWorkflow.on({
    push: {
      branches: ['main'],
      paths: [
        'docs/**',
        '.github/workflows/docs.yml',
        '.projenrc.ts',
        'CONTRIBUTING.md',
      ],
    },
    workflowDispatch: {},
  });
  docsPagesWorkflow.addJobs({
    build: {
      name: 'Build documentation',
      runsOn: ['ubuntu-latest'],
      permissions: {
        contents: JobPermission.READ,
        pages: JobPermission.WRITE,
        idToken: JobPermission.WRITE,
      },
      steps: [
        {
          name: 'Checkout repository',
          uses: 'actions/checkout@v5',
        },
        {
          name: 'Install, build, and upload site',
          uses: 'withastro/action@v6',
          with: {
            'path': 'docs',
            'node-version': '22',
            'package-manager': 'yarn',
            'build-cmd': 'yarn run docs:build',
          },
        },
      ],
    },
    deploy: {
      name: 'Deploy to GitHub Pages',
      needs: ['build'],
      runsOn: ['ubuntu-latest'],
      permissions: {
        pages: JobPermission.WRITE,
        idToken: JobPermission.WRITE,
      },
      environment: {
        name: 'github-pages',
        url: '${{ steps.deployment.outputs.page_url }}',
      },
      steps: [
        {
          name: 'Deploy to GitHub Pages',
          id: 'deployment',
          uses: 'actions/deploy-pages@v5',
        },
      ],
    },
  });
}

project.synth();
