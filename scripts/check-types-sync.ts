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
 * CDK ↔ CLI type sync drift check.
 *
 * The AGENTS.md "Shared API request/response shapes must stay in sync"
 * contract is enforced by developer discipline. Pre-S8 a missing field
 * (e.g. ``prompt_version``, ``attachments``) only surfaced via PR
 * review or runtime errors. This script statically compares
 * exported interfaces / type aliases in:
 *
 *   - ``cdk/src/handlers/shared/types.ts`` (canonical)
 *   - ``cli/src/types.ts`` (mirror)
 *
 * For every export name that exists in BOTH files, the structures
 * must match. CDK-only types are allowed (handler-internal shapes
 * the CLI doesn't need); CLI-only types are rejected (the CDK
 * is the source of truth, so a CLI type missing on CDK indicates
 * drift in the wrong direction).
 *
 * Run via ``mise run check:types-sync`` or
 * ``node --experimental-strip-types scripts/check-types-sync.ts``.
 *
 * Exit 0 on success, 1 on drift.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

interface ExportSummary {
  readonly kind: 'interface' | 'type-alias' | 'literal-const';
  /**
   * Stable normalized representation of the exported declaration's
   * structure. For interfaces: sorted-keys record of member name →
   * (optional? + type-text). For type aliases: the textual form of
   * the right-hand side. Suitable for value-equality comparison.
   */
  readonly shape: string;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CDK_TYPES_FILE = path.join(REPO_ROOT, 'cdk/src/handlers/shared/types.ts');
const CLI_TYPES_FILE = path.join(REPO_ROOT, 'cli/src/types.ts');

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
  'ApprovalDecisionRecordedEvent',
  // Server-side helper / internal contracts:
  'TaskNotificationsConfig',
  'NotificationChannelConfig',
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
  'GetTaskEventsQuery',
  // CLI on-disk config / credential cache:
  'CliConfig',
  'Credentials',
  // Terminal-status helper for CLI exit codes:
  'TERMINAL_STATUSES',
]);

function parseFile(filePath: string): Map<string, ExportSummary> {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const exports = new Map<string, ExportSummary>();

  for (const node of sourceFile.statements) {
    // Re-export declarations (``export type { Foo } from './bar'`` or
    // ``export type { Foo };`` after an import) are top-level
    // ExportDeclarations without an ``export`` modifier on the node —
    // handle them BEFORE the isExported gate so the names register.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const name = spec.name.text;
        exports.set(name, { kind: 'type-alias', shape: '__re-exported__' });
      }
      continue;
    }

    if (!isExported(node)) continue;

    if (ts.isInterfaceDeclaration(node)) {
      exports.set(node.name.text, summarizeInterface(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.set(node.name.text, summarizeTypeAlias(node));
    } else if (ts.isVariableStatement(node)) {
      // Constants like `export const APPROVAL_TIMEOUT_S_MIN = 30`.
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.set(decl.name.text, summarizeLiteralConst(decl));
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      // Skip exported functions — out of scope for type-sync.
    }
  }

  return exports;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function summarizeInterface(node: ts.InterfaceDeclaration): ExportSummary {
  const members: Array<[string, string]> = [];
  for (const m of node.members) {
    if (ts.isPropertySignature(m) && m.name) {
      const name = m.name.getText();
      const optional = m.questionToken ? '?' : '';
      const typeText = m.type ? m.type.getText().replace(/\s+/g, ' ').trim() : 'any';
      members.push([name, `${optional}${typeText}`]);
    }
  }
  members.sort(([a], [b]) => a.localeCompare(b));
  // Normalize ``readonly`` modifiers and `type` whitespace so
  // ``readonly foo: string`` and ``readonly foo : string`` compare equal.
  const shape = members.map(([n, t]) => `${n}${t}`).join('|');
  return { kind: 'interface', shape };
}

function summarizeTypeAlias(node: ts.TypeAliasDeclaration): ExportSummary {
  // Normalize whitespace on the RHS so formatting drift doesn't
  // trip the diff. Use sorted union members so
  // `'a' | 'b'` and `'b' | 'a'` compare equal.
  const raw = node.type.getText().replace(/\s+/g, ' ').trim();
  const sorted = raw
    .split('|')
    .map((s) => s.trim())
    .sort()
    .join('|');
  return { kind: 'type-alias', shape: sorted };
}

function summarizeLiteralConst(decl: ts.VariableDeclaration): ExportSummary {
  // Capture the textual initializer so a value drift (e.g.
  // APPROVAL_TIMEOUT_S_MIN = 30 vs 60) gets flagged. Whitespace
  // normalized to keep formatting churn out of the diff.
  const init = decl.initializer ? decl.initializer.getText().replace(/\s+/g, ' ').trim() : '';
  return { kind: 'literal-const', shape: init };
}

function main(): number {
  const cdk = parseFile(CDK_TYPES_FILE);
  const cli = parseFile(CLI_TYPES_FILE);

  const errors: string[] = [];

  // Walk CLI; every name must exist in CDK (or be allowlisted CLI-only).
  for (const [name, cliExport] of cli) {
    if (CLI_ONLY_ALLOWLIST.has(name)) continue;
    const cdkExport = cdk.get(name);
    if (!cdkExport) {
      errors.push(
        `CLI exports "${name}" but CDK does not — CDK is the source of truth, ` +
          `add it there first or add "${name}" to CLI_ONLY_ALLOWLIST in scripts/check-types-sync.ts ` +
          `with a comment explaining why it is client-only.`,
      );
      continue;
    }
    if (cdkExport.kind !== cliExport.kind) {
      errors.push(
        `"${name}" kind mismatch: CDK=${cdkExport.kind} vs CLI=${cliExport.kind}.`,
      );
      continue;
    }
    // If either side re-exports the type from a sibling module, the
    // shape can't be compared from this file alone — trust the
    // declaration site and accept the pair as in-sync.
    if (cdkExport.shape === '__re-exported__' || cliExport.shape === '__re-exported__') {
      continue;
    }
    if (cdkExport.shape !== cliExport.shape) {
      errors.push(
        `"${name}" shape drift between cdk/src/handlers/shared/types.ts and cli/src/types.ts.\n` +
          `  CDK: ${cdkExport.shape}\n` +
          `  CLI: ${cliExport.shape}`,
      );
    }
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

  if (errors.length > 0) {
    console.error('CDK ↔ CLI type sync drift detected:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error(`\n${errors.length} drift issue(s) found.`);
    return 1;
  }

  console.log(
    `CDK ↔ CLI type sync OK: ${cli.size} CLI exports validated against ${cdk.size} CDK exports ` +
      `(${CDK_ONLY_ALLOWLIST.size} server-only allowlisted).`,
  );
  return 0;
}

process.exit(main());
