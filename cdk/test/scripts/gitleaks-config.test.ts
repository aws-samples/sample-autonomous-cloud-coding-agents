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

/**
 * Test for the global allowlists (`[[allowlists]]`) of `.gitleaks.toml`.
 *
 * An entry applies to every rule and every file unless it names them, and gitleaks
 * ORs the criteria of an entry unless it sets `condition = "AND"`. A fixture value
 * that is allowed without those limits passes the secret scan wherever it is copied
 * to. No scan shows that an entry is wider than it has to be, so this suite reads
 * the entries. The allowlists of a rule (`[[rules.allowlists]]`) are not read: each
 * exempts findings of its own rule only.
 *
 * No JavaScript workspace declares a TOML parser, so the file is read as text, in
 * one form only: the one it is written in. gitleaks reads every other TOML spelling
 * of a table or a setting as well, and their names in any letter case, so a line
 * in another form fails the first test instead of going unread.
 *
 * How much a pattern of `paths` matches between its anchors is not checked: that
 * stays with the review.
 *
 * Same placement rationale as `check-constants-sync.test.ts`: `cdk/test/` is the
 * Jest tree that can reach the repository root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG = fs.readFileSync(path.resolve(__dirname, '../../../.gitleaks.toml'), 'utf-8');

/** A blank line or a comment: what gitleaks skips. */
const isSkipped = (line: string): boolean => /^\s*(#|$)/.test(line);

/**
 * A string that ends on the line it starts on. In double quotes the only escape is the
 * doubled backslash: every other character of a pattern is the one written. Either kind
 * holds only what `.` matches, and so no character that ends a line for JavaScript: TOML
 * takes such a character for part of the string, `allowlists` below for the start of a line.
 */
const STRING = String.raw`(?:"(?:(?!["\\]).|\\\\)*"|'''(?:(?!''').)*''')`;

/** The forms a line of the file may have, each one the whole line. */
const FORMS = [
  String.raw`\[extend\]|\[\[rules\]\]|\[\[(?:rules\.)?allowlists\]\]`, // a table: one of the four the file has
  String.raw`\w+ = (?:${STRING}|[\w.+-]+)`, // a setting: a string, a boolean or a number
  String.raw`\w+ = \[(?:${STRING}(?:, ${STRING})*\])?`, // an array of strings on one line, or the start of one that
  String.raw` {4}${STRING},`, // holds one string per line
  String.raw`\]`, // and ends on a line of its own
];
const FORM = new RegExp(`^(?:${FORMS.join('|')})$`);

/** The keys gitleaks reads in a global allowlist, spelled as its documentation spells them. */
const KEYS = ['description', 'targetRules', 'condition', 'paths', 'commits', 'regexes', 'regexTarget', 'stopwords'];

interface Allowlist {
  /** What a failure calls the entry: its description, or its line when it has none. */
  readonly name: string;
  /** The value of each key the entry sets, as written. */
  readonly settings: ReadonlyMap<string, string>;
}

/**
 * Every top-level `[[allowlists]]` table of a config. A config without one is refused:
 * its global allowlists, if it has any, are where this suite does not read them.
 */
const allowlists = (config: string): Allowlist[] => {
  const entries: Allowlist[] = config.split('\n').flatMap((header, index, lines) => {
    if (header !== '[[allowlists]]') {
      return [];
    }
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((line) => line.startsWith('['));
    const body = rest.slice(0, end < 0 ? undefined : end).filter((line) => !isSkipped(line)).join('\n');
    // A value is the rest of its line and, for an array that spans lines, the lines up to its end.
    const settings = new Map([...body.matchAll(/^(\w+) = (.*(?:\n[ \]].*)*)$/gm)].map((match): [string, string] => [match[1], match[2]]));
    return [{ name: settings.get('description') ?? `line ${index + 1}`, settings }];
  });
  if (entries.length === 0) {
    throw new Error('the config has no [[allowlists]] table');
  }
  return entries;
};

/**
 * The strings of a list; none for a key that is not set, and none for a string in the place of
 * the array. gitleaks takes such a string for its parts between commas: one string can be
 * several patterns, and an empty one is no rule.
 */
const strings = (value = ''): string[] => (value.startsWith('[') ? value.match(new RegExp(STRING, 'g')) : null) ?? [];

/** Whether a pattern has to match a whole path. A `|` would split it into alternatives anchored at one end each. */
const isAnchored = (pattern: string): boolean => /^("|''')\^[^|]+\$\1$/.test(pattern);

const names = (entries: Allowlist[]): string[] => entries.map((entry) => entry.name);

/** The lines of a config in none of the forms, and the keys of its global allowlists that are not spelled as in KEYS. */
const unread = (config: string): string[] => [
  ...config.split('\n').filter((line) => !isSkipped(line) && !FORM.test(line)),
  // To gitleaks a key in another letter case is the same key; to the two functions below it would be another one.
  ...allowlists(config).flatMap(({ settings }) => [...settings.keys()]).filter((key) => !KEYS.includes(key)),
];

/** The global allowlists of a config that list no file, or one in a pattern that is not anchored at both ends. */
const withoutFiles = (config: string): string[] => {
  const files = ({ settings }: Allowlist): string[] => strings(settings.get('paths'));

  return names(allowlists(config).filter((entry) => files(entry).length === 0 || !files(entry).every(isAnchored)));
};

/**
 * The global allowlists of a config that exempt a value or a commit without naming a rule
 * and setting `condition = "AND"`. With `paths` next to a value and no condition, the value
 * is allowed in every file and every finding of the rule is allowed in the listed files.
 */
const withoutRule = (config: string): string[] => {
  const narrowed = allowlists(config).filter(({ settings }) => ['stopwords', 'regexes', 'commits'].some((key) => settings.has(key)));

  return names(narrowed.filter(({ settings }) => strings(settings.get('targetRules')).length === 0 || settings.get('condition') !== '"AND"'));
};

describe('the global allowlists of .gitleaks.toml', () => {
  test('are written the way this suite reads them, like every line of the file', () => {
    expect(unread(CONFIG)).toEqual([]);
  });

  test('name the files they apply to, in patterns anchored at both ends', () => {
    expect(withoutFiles(CONFIG)).toEqual([]);
  });

  test('that exempt a value or a commit name their rule and require every criterion', () => {
    expect(withoutRule(CONFIG)).toEqual([]);
  });
});

// The file as it is would pass a looser reading as well, so these hold the reading itself.
describe('this suite', () => {
  /** A config that is one global allowlist. */
  const entry = (...lines: string[]): string => ['[[allowlists]]', ...lines].join('\n');
  const FILE = 'paths = ["^test/a$"]';
  const RULE = 'targetRules = ["a-rule"]';
  const VALUE = 'stopwords = ["a-value"]';

  test('finds nothing in an entry that names its rule and its file and requires both', () => {
    const config = entry('condition = "AND"', RULE, FILE, VALUE);

    expect([unread(config), withoutFiles(config), withoutRule(config)]).toEqual([[], [], []]);
  });

  // gitleaks takes this table for a global allowlist as well, in a config that has no other.
  test('refuses a config without a `[[allowlists]]` table', () => {
    expect(() => withoutFiles(['[allowlist]', VALUE].join('\n'))).toThrow('no [[allowlists]] table');
  });

  // gitleaks reads each of these lines: under a form that matched one, an entry could go unread.
  test.each([
    '[[Allowlists]]',
    '[[ allowlists ]]',
    '[["allowlists"]]',
    '[[allowlists]] # a fixture',
    '  [[allowlists]]',
    'stopwords=["a-value"]',
    '  stopwords = ["a-value"]',
    'description = """',
    'paths = ["^test/a\\u007Cb$"]',
    'allowlists = [{ stopwords = ["a-value"] }]',
    '[allowlist]',
    '[true]',
  ])('does not read the line %s', (line) => {
    expect(unread([line, entry(FILE)].join('\n'))).toEqual([line]);
  });

  // To TOML a line separator is one more character of a string.
  test.each(['"', "'''"])('does not read a string in %s that holds a line separator', (quote) => {
    const line = `description = ${quote}a${String.fromCharCode(0x2028)}fixture${quote}`;

    expect(unread([line, entry(FILE)].join('\n'))).toEqual([line]);
  });

  // To gitleaks this key is `stopwords`.
  test('does not read a key in another letter case', () => {
    expect(unread(entry(FILE, 'stopWords = ["a-value"]'))).toEqual(['stopWords']);
  });

  // Each of these entries lists no file, or a pattern that matches other paths than the one it names.
  test.each<string[]>([
    ['no `paths`', VALUE],
    ['`paths` under the table that follows it', VALUE, '[extend]', FILE],
    ['a pattern in a comment only', 'paths = [', '    # "^test/a$",', ']'],
    ['a pattern without a start anchor', 'paths = ["test/a$"]'],
    ['a pattern without an end anchor', 'paths = ["^test/a"]'],
    ['a pattern of two alternatives', 'paths = ["^test/a|test/b$"]'],
    ['an anchored pattern and one that is not', 'paths = ["^test/a$", "test/b"]'],
    ['its patterns in one string', "paths = '''^test/[ab]$,test/c$'''"],
  ])('does not take an entry with %s for one that names its files', (_label, ...lines) => {
    expect(withoutFiles(entry(...lines))).toEqual(['line 1']);
  });

  // Next to `paths`, gitleaks allows each of these in every file, or under every rule in the listed files.
  test.each<string[]>([
    ['a value', VALUE],
    ['a pattern for values', "regexes = ['''a-value''']"],
    ['a commit', 'commits = ["a-commit"]'],
    ['a value and no rule', 'condition = "AND"', VALUE],
    ['a value and a list of rules that names none', 'condition = "AND"', 'targetRules = [', ']', VALUE],
    ['a value and a string of rules that names none', 'condition = "AND"', 'targetRules = ""', VALUE],
    ['a value and `condition = "OR"`', 'condition = "OR"', RULE, VALUE],
  ])('does not take an entry with %s for one that names its rule and requires every criterion', (_label, ...lines) => {
    expect(withoutRule(entry(FILE, ...lines))).toEqual(['line 1']);
  });
});
