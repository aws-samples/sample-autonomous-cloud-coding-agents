#!/usr/bin/env node
/**
 * Sync slash-command stubs from `.abca/commands/` into IDE-specific dirs.
 *
 * For each file in `.abca/commands/`, writes the same filename under
 * `.claude/commands/` and `.cursor/commands/` with body = repo-relative
 * path to the canonical `.abca` file (one line, no trailing whitespace).
 *
 * Run: `node scripts/sync-abca-commands.mjs`
 *      `mise run sync:abca-commands`
 */

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(repoRoot, '.abca', 'commands');
const targetDirs = [
  path.join(repoRoot, '.claude', 'commands'),
  path.join(repoRoot, '.cursor', 'commands'),
];

function listSourceCommandFiles() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function writeStub(targetDir, filename, body) {
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, filename);
  fs.writeFileSync(targetPath, body, 'utf8');
}

function pruneOrphans(targetDir, keepNames) {
  if (!fs.existsSync(targetDir)) {
    return;
  }
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (!keepNames.has(entry.name)) {
      fs.unlinkSync(path.join(targetDir, entry.name));
    }
  }
}

function main() {
  const filenames = listSourceCommandFiles();
  const keepNames = new Set(filenames);

  for (const filename of filenames) {
    const relPath = path.posix.join('.abca', 'commands', filename);
    const body = `${relPath}\n`;
    for (const targetDir of targetDirs) {
      writeStub(targetDir, filename, body);
    }
  }

  for (const targetDir of targetDirs) {
    pruneOrphans(targetDir, keepNames);
  }

  console.log(
    `sync-abca-commands: ${filenames.length} command(s) → ${targetDirs.map((d) => path.relative(repoRoot, d)).join(', ')}`,
  );
}

main();
