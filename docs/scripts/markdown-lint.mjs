import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lint as markdownlint } from 'markdownlint/promise';

const config = {
  default: false,
  MD001: true,
  MD024: { siblings_only: true },
  MD025: true,
  MD045: true,
  MD056: true,
};

/** A hook's GIT_DIR must not point git at another repository. */
function gitLsFiles(repoRoot, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return execFileSync('git', ['ls-files', '-z', ...args], { cwd: repoRoot, env, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Lints the structure of every tracked Markdown file below `repoRoot`: table rows that lose
 * cells, images without alt text, a second top-level heading, repeated sibling headings,
 * skipped heading levels.
 *
 * Not linted: the Starlight mirrors in the subdirectories of docs/src/content/docs. The home
 * page at the top of that directory is linted.
 *
 * Returns the exit code: 0 clean, 1 findings or a refused setup, 2 markdownlint failed.
 */
export async function lint(repoRoot, { log = console.log, error = console.error } = {}) {
  // A tracked file that was deleted but not staged is still listed by git: skip it.
  const files = gitLsFiles(repoRoot, '--', '*.md', '*.mdx', ':(exclude,glob)docs/src/content/docs/*/**').filter((file) =>
    fs.existsSync(path.join(repoRoot, file)),
  );
  if (files.length < 10) {
    error(`ERROR: expected ≥10 Markdown files but found ${files.length} — scan may be misconfigured`);
    return 1;
  }

  let results;
  try {
    results = await markdownlint({ files: files.map((file) => path.join(repoRoot, file)), config, noInlineConfig: true });
  } catch (failure) {
    error(failure);
    error('ERROR: markdownlint failed before linting; its message is above.');
    return 2;
  }
  const findings = files.flatMap((file) => results[path.join(repoRoot, file)].map((finding) => ({ file, ...finding })));
  for (const { file, lineNumber, errorRange, ruleNames, ruleDescription, errorDetail, errorContext } of findings) {
    const column = errorRange ? `:${errorRange[0]}` : '';
    const detail = (errorDetail ? ` [${errorDetail}]` : '') + (errorContext ? ` [Context: "${errorContext}"]` : '');
    error(`${file}:${lineNumber}${column} error ${ruleNames.join('/')} ${ruleDescription}${detail}`);
  }
  if (findings.length > 0) {
    error('ERROR: structural Markdown errors, listed above as file:line[:column] rule description.');
    error('Fix the files: docs/AGENTS.md, "When the Markdown lint fails", says what each rule wants.');
    error('Comments such as <!-- markdownlint-disable --> are ignored on purpose.');
    return 1;
  }
  log(`markdown-lint: ${files.length} Markdown files, no structural errors`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = await lint(path.resolve(import.meta.dirname, '..', '..'));
}
