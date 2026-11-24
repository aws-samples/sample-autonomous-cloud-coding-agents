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

// gitleaks applies a global allowlist to every rule and every file unless the entry names them, and ORs the criteria of
// an entry unless it sets `condition = "AND"`. No JavaScript workspace declares a TOML parser, so the file is read as text.

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG = fs.readFileSync(path.resolve(__dirname, '../../../.gitleaks.toml'), 'utf-8');

const isSkipped = (line: string): boolean => /^\s*(#|$)/.test(line);

// A string on one line. In double quotes its only escape is the doubled backslash, so each character of a pattern is the
// one written. It holds no character that ends a line for JavaScript, which TOML takes for part of the string.
const STRING = String.raw`(?:"(?:(?!["\\]).|\\\\)*"|'''(?:(?!''').)*''')`;

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
  readonly name: string;
  readonly settings: ReadonlyMap<string, string>;
}

const allowlists = (config: string): Allowlist[] => {
  const entries: Allowlist[] = config.split('\n').flatMap((header, index, lines) => {
    if (header !== '[[allowlists]]') {
      return [];
    }
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((line) => line.startsWith('['));
    const body = rest.slice(0, end < 0 ? undefined : end).filter((line) => !isSkipped(line)).join('\n');
    const settings = new Map([...body.matchAll(/^(\w+) = (.*(?:\n[ \]].*)*)$/gm)].map((match): [string, string] => [match[1], match[2]]));
    return [{ name: settings.get('description') ?? `line ${index + 1}`, settings }];
  });
  if (entries.length === 0) {
    throw new Error('the config has no [[allowlists]] table');
  }
  return entries;
};

// None for a string in the place of an array. gitleaks splits such a string at its commas, so one string can be several
// patterns and an empty one is no rule.
const strings = (value = ''): string[] => (value.startsWith('[') ? value.match(new RegExp(STRING, 'g')) : null) ?? [];

/** Whether a pattern has to match a whole path. A `|` would split it into alternatives anchored at one end each. */
const isAnchored = (pattern: string): boolean => /^("|''')\^[^|]+\$\1$/.test(pattern);

const names = (entries: Allowlist[]): string[] => entries.map((entry) => entry.name);

const unread = (config: string): string[] => [
  ...config.split('\n').filter((line) => !isSkipped(line) && !FORM.test(line)),
  // To gitleaks a key in another letter case is the same key; to the two functions below it would be another one.
  ...allowlists(config).flatMap(({ settings }) => [...settings.keys()]).filter((key) => !KEYS.includes(key)),
];

const withoutFiles = (config: string): string[] => {
  const files = ({ settings }: Allowlist): string[] => strings(settings.get('paths'));

  return names(allowlists(config).filter((entry) => files(entry).length === 0 || !files(entry).every(isAnchored)));
};

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

  test.each(['"', "'''"])('does not read a string in %s that holds a line separator', (quote) => {
    const line = `description = ${quote}a${String.fromCharCode(0x2028)}fixture${quote}`;

    expect(unread([line, entry(FILE)].join('\n'))).toEqual([line]);
  });

  test('does not read a key in another letter case', () => {
    expect(unread(entry(FILE, 'stopWords = ["a-value"]'))).toEqual(['stopWords']);
  });

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
