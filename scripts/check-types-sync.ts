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
 * API type sync drift check.
 *
 * The AGENTS.md "Shared API request/response shapes must stay in sync"
 * contract is enforced by developer discipline. Pre-S8 a missing field
 * (e.g. ``prompt_version``, ``attachments``) only surfaced via PR
 * review or runtime errors. This script compares the exports of:
 *
 *   - ``cdk/src/handlers/shared/types.ts`` (canonical)
 *   - ``cli/src/types.ts`` (exact mirror)
 *   - ``web/src/core/api/types.ts`` (subset mirror)
 *
 * CLI: for every export name that exists in BOTH files, the structures
 * must match. CDK-only types are allowed (handler-internal shapes
 * the CLI doesn't need); CLI-only types are rejected (the CDK
 * is the source of truth, so a CLI type missing on CDK indicates
 * drift in the wrong direction). A CLI export that the CDK declares in
 * another module, possibly under another name, is listed in
 * ``CANON_ELSEWHERE`` and compared with that declaration.
 *
 * Web: the console mirrors only what it reads, so an export may leave
 * members out, but every member it declares must exist on the canonical
 * declaration with the same type and optionality. The canonical
 * declaration of a web export is, in this order: the CDK types file; the
 * CDK module listed for it in ``CANON_ELSEWHERE`` (the status lists,
 * the coding workflow id); the CLI mirror, which is the only place that
 * declares the envelopes and events the server builds inline. A web
 * export with none of these must be listed in ``WEB_ONLY_ALLOWLIST``;
 * those are the only web exports this check does not compare.
 *
 * Shapes are compared as the TypeScript compiler resolves them, not as
 * they are spelled: a re-export is followed to its declaration, ``extends``
 * clauses contribute their members, a derived union is compared by its
 * values, and a type declared in another file is compared member by member
 * rather than by name. Literal constants are compared by value.
 *
 * Run via ``mise run check:types-sync`` or
 * ``node --experimental-strip-types scripts/check-types-sync.ts``.
 *
 * Exit 0 on success, 1 on drift (or when the files cannot be compared).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** One exported name, as the compiler resolves it. */
interface ExportSummary {
  /** ``interface``, ``type-alias``, ``enum``, ``class``, ``function`` or ``literal-const`` (``+``-joined for a merged declaration). */
  readonly kind: string;
  /** Every kind but ``literal-const``: the resolved type. */
  readonly type?: ts.Type;
  /** ``literal-const``: the initializer text, with ``constants.json`` references resolved to their value. */
  readonly literal?: string;
  /** ``file:line`` of the declaration (the declaring file, for a re-export). */
  readonly location: string;
}

/** One member of an object type: a property, an index signature or a call signature. */
interface Member {
  readonly optional: boolean;
  readonly readonly: boolean;
  /** Union constituents of the member's type (``undefined`` left out for an optional member). */
  readonly types: readonly ts.Type[];
}

/** How the two files of one comparison are named in messages. */
interface Sides {
  readonly canon: string;
  readonly mirror: string;
  /** Subset mirror: object members missing from the mirror are not drift. */
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

/**
 * ``contracts/constants.json`` is the single source of truth for the
 * shared numeric bounds (``check-constants-sync.ts`` enforces that
 * Python and the JSON agree). The CDK imports these directly
 * (``import sharedConstants from '.../constants.json'``) because its
 * handlers are esbuild-bundled at deploy; the CLI is a plain
 * ``tsc --build`` published package whose ``rootDir`` can't reach the
 * file, so it mirrors the same numbers as literals. To compare the two
 * fairly we resolve any ``<alias>.a.b`` reference to a value loaded from
 * the JSON, so ``sharedConstants.approval_timeout_s.min`` and ``30``
 * normalize to the same shape — while a genuine literal drift (``60``)
 * still trips the diff.
 */
const SHARED_CONSTANTS: Record<string, unknown> = JSON.parse(
  fs.readFileSync(CONSTANTS_JSON_FILE, 'utf-8'),
);

/**
 * Names that are intentionally CDK-only — handler-internal shapes
 * the CLI doesn't consume. Adding to this list is a deliberate
 * signal that the type lives only on the server side.
 */
const CDK_ONLY_ALLOWLIST = new Set<string>([
  // Server-only persistence shapes (not part of the public API):
  'TaskRecord',
  'ApprovalRecord',
  'PendingApprovalRecord',
  'ApprovedApprovalRecord',
  'DeniedApprovalRecord',
  'TimedOutApprovalRecord',
  'StrandedApprovalRecord',
  'NudgeRecord',
  'EventRecord',
  'WebhookRecord',
  // Platform API key persistence shape — stores the secret hash and owner,
  // neither of which the CLI ever sees (CLI uses ApiKeyDetail).
  'ApiKeyRecord',
  'ApprovalDecisionRecordedEvent',
  // Console-API-only (GET /repos/{repo_id}/issues on the operator console stack's
  // own API, consumed by web/, never by the CLI; mirrored in web/src/core/api/types.ts):
  'RepoIssueSummary',
  'ListRepoIssuesResponse',
  // Server-side helper / internal contracts:
  'TaskNotificationsConfig',
  'ChannelConfig',
  // Internal extension shape used by create-task-core.ts to thread
  // Cedar HITL fields without widening the public CreateTaskRequest:
  'CreateTaskApprovalExtensions',
  // Server-side bound constants — sourced from contracts/constants.json
  // (S9). Cross-language drift is enforced by scripts/check-constants-sync.ts.
  'APPROVAL_GATE_CAP_MIN',
  'APPROVAL_GATE_CAP_MAX',
  'APPROVAL_GATE_CAP_DEFAULT',
  // Attachment validation / persistence (server-only; CLI uses
  // Attachment / AttachmentSummary / AttachmentUploadInstruction):
  'AttachmentDelivery',
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
  // Server-side record builders and record → response mappers (runtime
  // code, not wire shapes; the CLI only sees what they return):
  'createAttachmentRecord',
  'toTaskDetail',
  'toWebhookDetail',
  'toApiKeyDetail',
  'toTaskSummary',
]);

/**
 * Names that are intentionally CLI-only — terminal UX, response-
 * envelope, and persistence-on-disk shapes that don't exist on the
 * server side. Adding here is a deliberate signal.
 */
const CLI_ONLY_ALLOWLIST = new Set<string>([
  // Response envelopes that exist as helper shapes in the CLI but
  // are inlined / generated on the server (api-client.ts wraps
  // them; CDK responses are just the success body):
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
  // Error classification — derived server-side via a function and
  // emitted on TaskDetail. The CLI consumes the resulting interface
  // but the union of category strings is a CLI-only display
  // contract (CDK uses the function's narrowed return type).
  'ErrorClassification',
  'ErrorCategoryType',
  // Task event shape returned by /tasks/{id}/events. CDK builds the
  // response inline; only the CLI types it explicitly.
  'TaskEvent',
  // CLI on-disk config / credential cache:
  'CliConfig',
  'Credentials',
]);

/**
 * Members the console declares REQUIRED although the API accepts their
 * absence. Only that direction can be listed: a member the API requires
 * is never optional in a mirror.
 */
const WEB_REQUIRED_WHERE_CDK_OPTIONAL = new Set<string>([
  // The console only creates repository tasks, so it always names the repo:
  'CreateTaskRequest.repo',
  // Always sent: an absent ref makes the server pick the repo-less
  // `default/agent-v1` workflow.
  'CreateTaskRequest.workflow_ref',
]);
/** Entries of the list above that a comparison relied on; the rest are stale. */
const usedOptionalityEntries = new Set<string>();

/**
 * Mirror exports (CLI or web) whose canonical declaration is in a CDK
 * module other than the types file: that module and, where the mirror
 * uses another name, the name there. They are compared like the rest.
 */
const CANON_ELSEWHERE: ReadonlyMap<string, readonly [module: string, name?: string]> = new Map([
  ['TERMINAL_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['PRE_ACTIVE_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['ACTIVE_STATUSES', ['cdk/src/constructs/task-status.ts']],
  ['CODING_WORKFLOW_ID', ['cdk/src/handlers/shared/workflows.ts']],
  // The CLI's name for that id: what `submit` sends when no --workflow is
  // given. Not DEFAULT_WORKFLOW_ID of the same module ('default/agent-v1'),
  // which is the server's fallback for repo-less tasks, a different contract.
  ['DEFAULT_CODING_WORKFLOW_ID', ['cdk/src/handlers/shared/workflows.ts', 'CODING_WORKFLOW_ID']],
]);
/** The CDK modules named above, each once. */
const CANON_MODULES = [...new Set([...CANON_ELSEWHERE.values()].map(([module]) => module))];

/**
 * Web exports with no canonical declaration to compare against. Every
 * other web export is compared, so adding a name here is a deliberate
 * signal that nothing checks it.
 */
const WEB_ONLY_ALLOWLIST = new Set<string>([
  // The operator console stack's own API (Linear issues); its handlers
  // build these responses inline and the CLI never reads them:
  'LinearAgentState',
  'LinearIssueSummary',
  'LinearProjectIssues',
  'ListLinearIssuesResponse',
  'StartLinearIssueResponse',
  // One shape for the approve and the deny response, which the CDK and the
  // CLI declare as two types (ApprovalResponse, DenyResponse):
  'DecisionResponse',
  // Limits regrouped into one object each. Their values mirror
  // MIN_MAX_TURNS / MAX_MAX_TURNS / DEFAULT_MAX_TURNS in
  // cdk/src/handlers/shared/validation.ts and `max_budget_usd` in
  // contracts/constants.json, but under other names, so this check cannot
  // pair them:
  'TURN_LIMIT',
  'BUDGET_LIMIT_USD',
]);

// One program over the compared files, so every type is resolved by the compiler:
// across re-exports, `extends` clauses and imports from sibling modules.
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
/** Guards `serialize` against a type that expands without end. */
const MAX_DEPTH = 40;

/** A type as a message shows it: by name, and a literal (an enum member included) by its value. */
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

/**
 * An interface or class from the standard library or an installed package
 * (`Array`, `Promise`, `Date`, an SDK shape): compared by name and type
 * arguments, never expanded. Everything declared in this repository is
 * expanded, wherever it is declared.
 */
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

/** Every member of an object type: properties (inherited ones included), index signatures, call and construct signatures. */
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

/** Canonical text of a type: equal text means equal structure. */
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

/** Member-level differences between two object types. */
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

/** Differences between two types that stand in the same place, or `undefined` when they cannot be compared member by member. */
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

/**
 * Member-level differences between two types, each given as its union
 * constituents. Empty when the two match (for a subset mirror: when
 * everything the mirror declares matches).
 */
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

  // Pair what differs: same displayed name first, then a lone leftover on each side.
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
    // An exact mirror whose texts differ must yield a difference; never report "equal" by omission.
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

/**
 * Collect local identifiers bound to a default-import of
 * ``contracts/constants.json`` so property accesses through them can be
 * resolved to concrete JSON values. Matches the import by specifier
 * basename (``constants.json``) regardless of the relative path depth,
 * which differs between the CDK (``../../../../``) and any future CLI use.
 */
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

/**
 * Resolve a ``<alias>.a.b`` property-access chain rooted at a
 * constants.json default-import to its JSON value, returning the value's
 * textual form (e.g. ``30``). Returns ``undefined`` for any expression
 * that isn't such a chain or doesn't resolve to a primitive in the JSON.
 */
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

/**
 * The value of an initializer made of literals — ``[Status.A, 'B']``,
 * ``{ min: 1 } as const`` — so that two spellings of one value compare
 * equal. ``undefined`` for anything computed.
 */
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
  // Capture the initializer so a value drift (e.g.
  // APPROVAL_TIMEOUT_S_MIN = 30 vs 60) gets flagged. A reference into
  // contracts/constants.json (e.g. ``sharedConstants.approval_timeout_s.min``)
  // is first resolved to its JSON value so it compares equal to the
  // mirrored literal on the other side; an initializer made of literals is
  // compared by value; anything else by its text, whitespace normalized to
  // keep formatting churn out of the diff.
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
  // Constants like `export const APPROVAL_TIMEOUT_S_MIN = 30`.
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

/** Every name a file exports, with a re-export followed to its declaration. */
function collectExports(file: string, errors: string[]): Map<string, ExportSummary> {
  const sourceFile = program.getSourceFile(path.join(REPO_ROOT, file));
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  if (!sourceFile || !moduleSymbol) throw new Error(`${file} is missing or exports nothing.`);
  const [diagnostic] = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
  if (diagnostic) {
    // A type the compiler cannot resolve is `any`, and `any` matches `any`:
    // a file with errors is never reported as in sync.
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

/** Drift between a canonical export and its mirror, as zero or one message. */
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
  /** The declaration CANON_ELSEWHERE names for a mirror export, when it names one and the module has it. */
  const canonElsewhere = (name: string): ExportSummary | undefined => {
    const [module, canonName = name] = CANON_ELSEWHERE.get(name) ?? [];
    return module === undefined ? undefined : elsewhere.get(module)?.get(canonName);
  };

  // Walk CLI; every name must exist in CDK (or be allowlisted CLI-only).
  for (const [name, cliExport] of cli) {
    if (CLI_ONLY_ALLOWLIST.has(name)) continue;
    const cdkExport = cdk.get(name) ?? canonElsewhere(name);
    // An entry of CANON_ELSEWHERE that leads nowhere is reported with the entries, below.
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

  // Walk CDK; every non-allowlisted name must exist in CLI.
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

  // An allowlist entry must still be true: the name exists on its side, and
  // only there. A name both sides export is a pair, and a pair is compared.
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

  // Walk web; every export is held to its canonical declaration (see the
  // header for the order) or must be listed as console-only.
  let webCompared = 0;
  for (const [name, webExport] of web) {
    let canon = cdk.get(name) ?? canonElsewhere(name);
    let sides = WEB;
    // An entry of CANON_ELSEWHERE that leads nowhere is reported with the entries, below.
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
