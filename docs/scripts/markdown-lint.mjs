import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { main as markdownlint } from 'markdownlint-cli2';

/**
 * The one markdownlint configuration: five structural rules, inline `markdownlint-disable`
 * comments ignored. Style rules are off on purpose.
 */
const config = path.resolve(import.meta.dirname, '..', '.markdownlint-cli2.jsonc');

/** `git ls-files` in `repoRoot`. A hook's GIT_DIR must not point git at another repository. */
function gitLsFiles(repoRoot, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return execFileSync('git', ['ls-files', '-z', ...args], { cwd: repoRoot, env, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Lints the structure of every tracked Markdown file below `repoRoot`: table rows that lose
 * cells, images without alt text, a second top-level heading, repeated sibling headings,
 * skipped heading levels. The list comes from git, so a new file or directory is covered as
 * soon as it is added, without touching this script.
 *
 * Not linted: the Starlight mirrors, generated from these sources into the subdirectories
 * of docs/src/content/docs. The home page at the top of that directory is written by hand,
 * so it is linted.
 *
 * Returns the exit code: 0 clean, 1 findings or a refused setup, 2 markdownlint-cli2 failed.
 */
export async function lint(repoRoot, { log = console.log, error = console.error } = {}) {
  // markdownlint-cli2 also reads any .markdownlint* file in the directory of a linted file
  // or above it, and such a file can switch rules off or drop files. The rules are the same
  // for every file, so `config` is the only one allowed, tracked or not.
  const allowed = path.relative(repoRoot, config).split(path.sep).join('/');
  const stray = gitLsFiles(repoRoot, '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.markdownlint*').filter(
    (file) => file !== allowed,
  );
  if (stray.length > 0) {
    error(`ERROR: markdownlint configuration found outside docs/.markdownlint-cli2.jsonc:\n${stray.map((file) => `  ${file}`).join('\n')}`);
    error('Remove it: the structural rules apply to every Markdown file. Fix the file the lint reports instead.');
    return 1;
  }

  // A tracked file that was deleted but not staged is still listed by git: skip it.
  const files = gitLsFiles(repoRoot, '--', '*.md', '*.mdx', ':(exclude,glob)docs/src/content/docs/*/**').filter((file) =>
    fs.existsSync(path.join(repoRoot, file)),
  );
  if (files.length < 10) {
    error(`ERROR: expected ≥10 Markdown files but found ${files.length} — scan may be misconfigured`);
    return 1;
  }

  let status;
  try {
    // The CLI's own entry point. ":" makes it read a path literally instead of as a glob.
    status = await markdownlint({
      directory: repoRoot,
      argv: ['--config', config, '--no-globs', ...files.map((file) => `:${file}`)],
      logMessage: log,
      logError: error,
    });
  } catch (failure) {
    error(failure);
    error('ERROR: markdownlint-cli2 failed before linting; its message is above.');
    return 2;
  }
  if (status !== 0) {
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
