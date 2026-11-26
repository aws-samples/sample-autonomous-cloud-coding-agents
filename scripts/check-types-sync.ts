#!/usr/bin/env -S node --experimental-strip-types
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
 * API type sync drift check. Compares the exports of:
 *
 *   - ``cdk/src/handlers/shared/types.ts`` (canonical)
 *   - ``cli/src/types.ts`` (exact mirror)
 *   - ``web/src/core/api/types.ts`` (subset mirror)
 *
 * Run via ``mise run check:types-sync`` or
 * ``node --experimental-strip-types scripts/check-types-sync.ts``.
 *
 * Exit 0 on success, 1 on drift (or when the files cannot be compared).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

interface ExportSummary {
  readonly kind: string;
  readonly type?: ts.Type;
  readonly literal?: string;
  readonly location: string;
}

interface Member {
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly types: readonly ts.Type[];
}

interface Sides {
  readonly canon: string;
  readonly mirror: string;
  readonly subset: boolean;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CDK_TYPES = 'cdk/src/handlers/shared/types.ts';
const CLI_TYPES = 'cli/src/types.ts';
const WEB_TYPES = 'web/src/core/api/types.ts';
const CONSTANTS_JSON_FILE = path.join(REPO_ROOT, 'contracts/constants.json');
const CLI: Sides = { canon: 'CDK', mirror: 'CLI', subset: false };
const WEB: Sides = { canon: 'CDK', mirror: 'web', subset: true };
const WEB_VS_CLI: Sides = { canon: 'CLI', mirror: 'web', subset: true };

const SHARED_CONSTANTS: Record<string, unknown> = JSON.parse(
  fs.readFileSync(CONSTANTS_JSON_FILE, 'utf-8'),
);

const CDK_ONLY_ALLOWLIST = new Set<string>([
  'TaskRecord',
  'NudgeRecord',
  'EventRecord',
  'WebhookRecord',
  'ApiKeyRecord',
  'ApprovalDecisionRecordedEvent',
  'ApprovalStatus',
  'RepoIssueSummary',
  'ListRepoIssuesResponse',
  'TaskNotificationsConfig',
  'ChannelConfig',
  'APPROVAL_GATE_CAP_MIN',
  'APPROVAL_GATE_CAP_MAX',
  'APPROVAL_GATE_CAP_DEFAULT',
  'InlineAttachment',
  'PresignedAttachment',
  'UrlAttachment',
  'ValidatedAttachment',
  'ScreeningResult',
  'AttachmentRecord',
  'PendingAttachmentRecord',
  'PassedAttachmentRecord',
  'BlockedAttachmentRecord',
  'CreateAttachmentRecordParams',
  'AgentAttachmentPayload',
  'createAttachmentRecord',
  'toTaskDetail',
  'toWebhookDetail',
  'toApiKeyDetail',
  'toTaskSummary',
]);

const CLI_ONLY_ALLOWLIST = new Set<string>([
  'SuccessResponse',
  'ErrorResponse',
  'PaginatedResponse',
  'Pagination',
  'CancelTaskResponse',
  'SlackLinkResponse',
  'LinearLinkResponse',
  'LinearRemoveWorkspaceResponse',
  'JiraLinkResponse',
  'TraceUrlResponse',
  'ErrorClassification',
  'ErrorCategoryType',
  'TaskEvent',
  'CliConfig',
  'Credentials',
]);

const WEB_REQUIRED_WHERE_CDK_OPTIONAL = new Set<string>([
  'CreateTaskRequest.repo',
  'CreateTaskRequest.workflow_ref',
]);
const usedOptionalityEntries = new Set<string>();

const CANON_ELSEWHERE: ReadonlyMap<string, readonly [module: string, name?: string]> = new Map([
  ['TERMINAL_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['PRE_ACTIVE_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['ACTIVE_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['CODING_WORKFLOW_ID', ['cdk/src/handlers/shared/workflows.ts']],
  ['DEFAULT_CODING_WORKFLOW_ID', ['cdk/src/handlers/shared/workflows.ts', 'CODING_WORKFLOW_ID']],
]);
const CANON_MODULES = [...new Set([...CANON_ELSEWHERE.values()].map(([module]) => module))];

const WEB_ONLY_ALLOWLIST = new Set<string>([
  'LinearAgentState',
  'LinearIssueSummary',
  'LinearProjectIssues',
  'ListLinearIssuesResponse',
  'StartLinearIssueResponse',
  'DecisionResponse',
  'TURN_LIMIT',
  'BUDGET_LIMIT_USD',
]);

const program = ts.createProgram(
  [CDK_TYPES, CLI_TYPES, WEB_TYPES, ...CANON_MODULES].map((file) => path.join(REPO_ROOT, file)),
  {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    typeRoots: [path.join(REPO_ROOT, 'node_modules/@types')],
  },
);
const checker = program.getTypeChecker();
const MAX_DEPTH = 40;

function show(type: ts.Type): string {
  if (type.isLiteral() && typeof type.value !== 'object') return JSON.stringify(type.value);
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

function constituents(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function typeArguments(type: ts.Type): readonly ts.Type[] {
  const isReference = ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference) : [];
}

function isLibraryType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol || !(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class))) return false;
  const declarations = symbol.declarations ?? [];
  return declarations.length > 0 && declarations.every((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return program.isSourceFileDefaultLibrary(sourceFile) || program.isSourceFileFromExternalLibrary(sourceFile);
  });
}

function isReadonly(property: ts.Symbol): boolean {
  return (property.declarations ?? []).some(
    (declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0,
  );
}

function serializeSignature(signature: ts.Signature, stack: readonly ts.Type[]): string {
  const parameters = signature.getParameters().map((p) => serialize(checker.getTypeOfSymbol(p), stack));
  return `(${parameters.join(', ')}) => ${serialize(signature.getReturnType(), stack)}`;
}

function membersOf(type: ts.Type, stack: readonly ts.Type[] = []): Map<string, Member> {
  const members = new Map<string, Member>();
  for (const property of checker.getPropertiesOfType(type)) {
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const types = constituents(checker.getTypeOfSymbol(property));
    members.set(property.name, {
      optional,
      readonly: isReadonly(property),
      types: optional ? types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)) : types,
    });
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    members.set(`[${serialize(info.keyType, stack)}]`, {
      optional: false,
      readonly: info.isReadonly,
      types: constituents(info.type),
    });
  }
  const signature = { optional: false, readonly: false, types: [] };
  for (const s of type.getCallSignatures()) members.set(serializeSignature(s, stack), signature);
  for (const s of type.getConstructSignatures()) members.set(`new ${serializeSignature(s, stack)}`, signature);
  return members;
}

function serialize(type: ts.Type, stack: readonly ts.Type[] = []): string {
  if (type.isUnion() || type.isIntersection()) {
    const parts = [...new Set(type.types.map((t) => serialize(t, stack)))].sort();
    return parts.join(type.isUnion() ? ' | ' : ' & ');
  }
  if (!(type.flags & ts.TypeFlags.Object)) return show(type);
  if (checker.isTupleType(type) || isLibraryType(type)) {
    const name = checker.isTupleType(type)
      ? `${(type as ts.TupleTypeReference).target.readonly ? 'readonly ' : ''}tuple`
      : checker.getFullyQualifiedName(type.symbol);
    return `${name}<${typeArguments(type).map((t) => serialize(t, stack)).join(', ')}>`;
  }
  if (stack.includes(type) || stack.length >= MAX_DEPTH) return `<recursive ${show(type)}>`;
  const inner = [...stack, type];
  const members = [...membersOf(type, inner)].map(([key, member]) => {
    const types = [...new Set(member.types.map((t) => serialize(t, inner)))].sort().join(' | ');
    return `${member.readonly ? 'readonly ' : ''}${key}${member.optional ? '?' : ''}: ${types}`;
  });
  return `{ ${members.sort().join('; ')} }`;
}

function isExpandable(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0 && !checker.isTupleType(type) && !isLibraryType(type);
}

function diffMembers(
  canon: Map<string, Member>,
  mirror: Map<string, Member>,
  where: string,
  sides: Sides,
): string[] {
  const lines: string[] = [];
  const missing = [...canon.keys()].filter((key) => !mirror.has(key));
  const extra = [...mirror.keys()].filter((key) => !canon.has(key));
  if (missing.length > 0 && !sides.subset) lines.push(`${where}: only in ${sides.canon}: ${missing.join(', ')}`);
  if (extra.length > 0) lines.push(`${where}: only in ${sides.mirror}: ${extra.join(', ')}`);
  for (const [key, c] of canon) {
    const m = mirror.get(key);
    if (!m) continue;
    const at = key.startsWith('[') ? `${where}${key}` : `${where}.${key}`;
    if (c.optional !== m.optional) {
      const allowed = sides.subset && c.optional && WEB_REQUIRED_WHERE_CDK_OPTIONAL.has(at);
      if (allowed) usedOptionalityEntries.add(at);
      else lines.push(`${at}: ${c.optional ? 'optional' : 'required'} in ${sides.canon}, ${m.optional ? 'optional' : 'required'} in ${sides.mirror}`);
    }
    if (c.readonly !== m.readonly) {
      lines.push(`${at}: ${c.readonly ? 'readonly' : 'writable'} in ${sides.canon}, ${m.readonly ? 'readonly' : 'writable'} in ${sides.mirror}`);
    }
    lines.push(...diffTypes(c.types, m.types, at, sides));
  }
  return lines;
}

function diffPair(canon: ts.Type, mirror: ts.Type, where: string, sides: Sides): string[] | undefined {
  if (isExpandable(canon) && isExpandable(mirror)) {
    return diffMembers(membersOf(canon), membersOf(mirror), where, sides);
  }
  const canonArgs = typeArguments(canon);
  const mirrorArgs = typeArguments(mirror);
  const sameContainer = checker.isTupleType(canon)
    ? checker.isTupleType(mirror)
    : isLibraryType(canon) && isLibraryType(mirror) && canon.getSymbol() === mirror.getSymbol();
  if (!sameContainer || canonArgs.length === 0 || canonArgs.length !== mirrorArgs.length) return undefined;
  const element = checker.isArrayType(canon) ? () => '[]' : (i: number) => `<${i}>`;
  return canonArgs.flatMap((arg, i) =>
    diffTypes(constituents(arg), constituents(mirrorArgs[i]), `${where}${element(i)}`, sides));
}

function diffTypes(
  canon: readonly ts.Type[],
  mirror: readonly ts.Type[],
  where: string,
  sides: Sides,
): string[] {
  const canonTexts = new Set(canon.map((t) => serialize(t)));
  const mirrorTexts = new Set(mirror.map((t) => serialize(t)));
  let onlyCanon = canon.filter((t) => !mirrorTexts.has(serialize(t)));
  let onlyMirror = mirror.filter((t) => !canonTexts.has(serialize(t)));
  if (onlyCanon.length === 0 && onlyMirror.length === 0) return [];

  const lines: string[] = [];
  const pairs: Array<[ts.Type, ts.Type]> = [];
  for (const c of onlyCanon) {
    const partner = onlyMirror.find((m) => show(m) === show(c) && !pairs.some(([, taken]) => taken === m));
    if (partner) pairs.push([c, partner]);
  }
  if (pairs.length === 0 && onlyCanon.length === 1 && onlyMirror.length === 1) pairs.push([onlyCanon[0], onlyMirror[0]]);
  for (const [c, m] of pairs) {
    const nested = diffPair(c, m, where, sides);
    if (nested === undefined) continue;
    onlyCanon = onlyCanon.filter((t) => t !== c);
    onlyMirror = onlyMirror.filter((t) => t !== m);
    if (nested.length === 0 && !sides.subset) nested.push(`${where}: ${show(c)} differs`);
    lines.push(...nested);
  }
  if (onlyCanon.length > 0 && onlyMirror.length > 0) {
    lines.push(`${where}: ${onlyCanon.map(show).join(' | ')} in ${sides.canon}, ${onlyMirror.map(show).join(' | ')} in ${sides.mirror}`);
  } else if (onlyCanon.length > 0) {
    lines.push(`${where}: ${onlyCanon.map(show).join(' | ')} only in ${sides.canon}`);
  } else if (onlyMirror.length > 0) {
    lines.push(`${where}: ${onlyMirror.map(show).join(' | ')} only in ${sides.mirror}`);
  }
  return lines;
}

function collectConstantsAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (const node of sourceFile.statements) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      path.basename(node.moduleSpecifier.text) === 'constants.json' &&
      node.importClause?.name
    ) {
      aliases.add(node.importClause.name.text);
    }
  }
  return aliases;
}

function resolveConstantsReference(
  expr: ts.Expression,
  aliases: Set<string>,
): string | undefined {
  if (aliases.size === 0 || !ts.isPropertyAccessExpression(expr)) return undefined;
  const segments: string[] = [];
  let cursor: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cursor)) {
    segments.unshift(cursor.name.text);
    cursor = cursor.expression;
  }
  if (!ts.isIdentifier(cursor) || !aliases.has(cursor.text)) return undefined;
  let value: unknown = SHARED_CONSTANTS;
  for (const seg of segments) {
    if (value == null || typeof value !== 'object') return undefined;
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- read-only walk down build-time-trusted contracts/constants.json; `seg` keys come from this script's own TS AST, not external input, and no object property is ever assigned (value is reassigned, never written).
    value = (value as Record<string, unknown>)[seg];
  }
  if (value == null || typeof value === 'object') return undefined;
  return JSON.stringify(value);
}

function literalValue(expr: ts.Expression): unknown {
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return literalValue(expr.expression);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const items = expr.elements.map(literalValue);
    return items.includes(undefined) ? undefined : items;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const entries: Array<[string, unknown]> = [];
    for (const property of expr.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return undefined;
      const value = literalValue(property.initializer);
      if (value === undefined) return undefined;
      entries.push([property.name.text, value]);
    }
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  const type = checker.getTypeAtLocation(expr);
  if (type.isLiteral() && typeof type.value !== 'object') return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type) === 'true';
  return undefined;
}

function summarizeLiteralConst(decl: ts.VariableDeclaration): string {
  if (!decl.initializer) return '';
  const resolved = resolveConstantsReference(decl.initializer, collectConstantsAliases(decl.getSourceFile()));
  if (resolved !== undefined) return resolved;
  const value = literalValue(decl.initializer);
  return value === undefined ? decl.initializer.getText().replace(/\s+/g, ' ').trim() : JSON.stringify(value);
}

function summarize(symbol: ts.Symbol): ExportSummary {
  const kinds: string[] = [];
  let type: ts.Type | undefined;
  let literal: string | undefined;
  if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
    kinds.push(symbol.flags & ts.SymbolFlags.Interface ? 'interface' : 'type-alias');
    type = checker.getDeclaredTypeOfSymbol(symbol);
  }
  for (const [flag, kind] of [
    [ts.SymbolFlags.Enum, 'enum'],
    [ts.SymbolFlags.Class, 'class'],
    [ts.SymbolFlags.Function, 'function'],
  ] as const) {
    if (symbol.flags & flag) {
      kinds.push(kind);
      type ??= checker.getTypeOfSymbol(symbol);
    }
  }
  if (symbol.valueDeclaration && ts.isVariableDeclaration(symbol.valueDeclaration)) {
    kinds.push('literal-const');
    literal = summarizeLiteralConst(symbol.valueDeclaration);
  }
  const [declaration] = symbol.declarations ?? [];
  const sourceFile = declaration?.getSourceFile();
  const location = sourceFile
    ? `${path.relative(REPO_ROOT, sourceFile.fileName)}:${sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1}`
    : 'unknown location';
  return { kind: kinds.join('+'), type, literal, location };
}

function collectExports(file: string, errors: string[]): Map<string, ExportSummary> {
  const sourceFile = program.getSourceFile(path.join(REPO_ROOT, file));
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  if (!sourceFile || !moduleSymbol) throw new Error(`${file} is missing or exports nothing.`);
  const [diagnostic] = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
  if (diagnostic) {
    const line = diagnostic.start === undefined ? '' : `:${sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    errors.push(
      `${file}${line} does not type-check, so its shapes cannot be trusted: ` +
        `${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} Fix that first.`,
    );
  }
  const exports = new Map<string, ExportSummary>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    exports.set(exported.name, summarize(symbol));
  }
  return exports;
}

function compareExport(name: string, canon: ExportSummary, mirror: ExportSummary, sides: Sides): string[] {
  if (canon.kind === '' || mirror.kind === '') {
    return [`"${name}" (${canon.location}, ${mirror.location}) is exported as a declaration this check cannot compare. Declare shared shapes as an interface, type alias, enum or constant.`];
  }
  if (canon.kind !== mirror.kind) {
    return [`"${name}" kind mismatch: ${sides.canon}=${canon.kind} (${canon.location}) vs ${sides.mirror}=${mirror.kind} (${mirror.location}).`];
  }
  const lines: string[] = [];
  if (canon.literal !== mirror.literal) {
    lines.push(`${name}: ${canon.literal} in ${sides.canon}, ${mirror.literal} in ${sides.mirror}`);
  }
  if (canon.type && mirror.type) {
    lines.push(...diffTypes(constituents(canon.type), constituents(mirror.type), name, sides));
  }
  if (lines.length === 0) return [];
  return [
    `"${name}" differs between ${canon.location} (${sides.canon}) and ${mirror.location} (${sides.mirror}):\n` +
      lines.map((line) => `      ${line}`).join('\n'),
  ];
}

function main(): number {
  const errors: string[] = [];
  const cdk = collectExports(CDK_TYPES, errors);
  const cli = collectExports(CLI_TYPES, errors);
  const web = collectExports(WEB_TYPES, errors);
  const elsewhere = new Map(CANON_MODULES.map((file) => [file, collectExports(file, errors)] as const));
  const canonElsewhere = (name: string): ExportSummary | undefined => {
    const [module, canonName = name] = CANON_ELSEWHERE.get(name) ?? [];
    return module === undefined ? undefined : elsewhere.get(module)?.get(canonName);
  };

  for (const [name, cliExport] of cli) {
    if (CLI_ONLY_ALLOWLIST.has(name)) continue;
    const cdkExport = cdk.get(name) ?? canonElsewhere(name);
    if (!cdkExport && CANON_ELSEWHERE.has(name)) continue;
    if (!cdkExport) {
      errors.push(
        `CLI exports "${name}" but CDK does not — CDK is the source of truth, ` +
          `add it there first or add "${name}" to CLI_ONLY_ALLOWLIST in scripts/check-types-sync.ts ` +
          `with a comment explaining why it is client-only.`,
      );
      continue;
    }
    errors.push(...compareExport(name, cdkExport, cliExport, CLI));
  }

  for (const [name] of cdk) {
    if (CDK_ONLY_ALLOWLIST.has(name)) continue;
    if (!cli.has(name)) {
      errors.push(
        `CDK exports "${name}" but CLI does not. ` +
          `Either mirror it in cli/src/types.ts or add to CDK_ONLY_ALLOWLIST in scripts/check-types-sync.ts ` +
          `with a comment explaining why it is server-only.`,
      );
    }
  }

  for (const [list, listName, own, ownFile, other, otherFile] of [
    [CDK_ONLY_ALLOWLIST, 'CDK_ONLY_ALLOWLIST', cdk, CDK_TYPES, cli, CLI_TYPES],
    [CLI_ONLY_ALLOWLIST, 'CLI_ONLY_ALLOWLIST', cli, CLI_TYPES, cdk, CDK_TYPES],
  ] as const) {
    for (const name of list) {
      if (!own.has(name)) {
        errors.push(`${listName} in scripts/check-types-sync.ts names "${name}", which ${ownFile} does not export. Remove the stale entry.`);
      } else if (other.has(name)) {
        errors.push(`${listName} in scripts/check-types-sync.ts names "${name}", but ${otherFile} exports it too. Remove the entry so the two declarations are compared.`);
      } else if (CANON_ELSEWHERE.has(name)) {
        errors.push(`${listName} in scripts/check-types-sync.ts names "${name}", but CANON_ELSEWHERE there gives it a canonical declaration. Remove the entry so the two declarations are compared.`);
      }
    }
  }

  let webCompared = 0;
  for (const [name, webExport] of web) {
    let canon = cdk.get(name) ?? canonElsewhere(name);
    let sides = WEB;
    if (!canon && CANON_ELSEWHERE.has(name)) continue;
    if (!canon && cli.has(name)) {
      canon = cli.get(name);
      sides = WEB_VS_CLI;
    }
    if (!canon) {
      if (!WEB_ONLY_ALLOWLIST.has(name)) {
        errors.push(
          `web exports "${name}" but neither ${CDK_TYPES} nor ${CLI_TYPES} declares it, so nothing checks its shape. ` +
            `If the type was renamed there, rename it in ${WEB_TYPES} too; if it is declared in another CDK module, ` +
            `add it to CANON_ELSEWHERE in scripts/check-types-sync.ts; if the console alone uses it, add "${name}" ` +
            `to WEB_ONLY_ALLOWLIST there with a comment explaining why.`,
        );
      }
      continue;
    }
    webCompared++;
    errors.push(...compareExport(name, canon, webExport, sides));
  }
  if (webCompared === 0) {
    errors.push(`${WEB_TYPES} shares no export name with ${CDK_TYPES}, so the web mirror check compared nothing.`);
  }
  for (const name of WEB_ONLY_ALLOWLIST) {
    if (!web.has(name)) {
      errors.push(`WEB_ONLY_ALLOWLIST in scripts/check-types-sync.ts names "${name}", which ${WEB_TYPES} does not export. Remove the stale entry.`);
    } else if (cdk.has(name) || cli.has(name) || CANON_ELSEWHERE.has(name)) {
      errors.push(`WEB_ONLY_ALLOWLIST in scripts/check-types-sync.ts names "${name}", but it has a canonical declaration. Remove the entry so the two declarations are compared.`);
    }
  }
  for (const [name, [module, canonName = name]] of CANON_ELSEWHERE) {
    if (!elsewhere.get(module)?.has(canonName)) {
      errors.push(`CANON_ELSEWHERE in scripts/check-types-sync.ts says ${module} declares "${canonName}", but that module does not export it. Point the entry at the module that does.`);
    }
    if (!cli.has(name) && !web.has(name)) {
      errors.push(`CANON_ELSEWHERE in scripts/check-types-sync.ts names "${name}", which neither ${CLI_TYPES} nor ${WEB_TYPES} exports. Remove the stale entry.`);
    } else if (cdk.has(name)) {
      errors.push(`CANON_ELSEWHERE in scripts/check-types-sync.ts sends "${name}" to ${module}, but ${CDK_TYPES} exports it. Remove the entry.`);
    }
  }
  for (const entry of WEB_REQUIRED_WHERE_CDK_OPTIONAL) {
    if (!usedOptionalityEntries.has(entry)) {
      errors.push(`WEB_REQUIRED_WHERE_CDK_OPTIONAL in scripts/check-types-sync.ts names "${entry}", which is not a member the web requires and the CDK leaves optional. Remove the stale entry.`);
    }
  }

  if (errors.length > 0) {
    console.error('API type sync drift detected:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error(
      `\n${errors.length} drift issue(s) found. The CDK file is the source of truth: ` +
        'bring the mirror in line with it, or change the CDK shape and its mirrors together.',
    );
    return 1;
  }

  console.log(
    `CDK ↔ CLI type sync OK: ${cli.size} CLI exports validated against ${cdk.size} CDK exports ` +
      `(${CDK_ONLY_ALLOWLIST.size} server-only allowlisted). ` +
      `CDK ↔ web: ${webCompared} of ${web.size} web exports match their canonical declaration ` +
      `(${WEB_ONLY_ALLOWLIST.size} console-only allowlisted).`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`check-types-sync: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
