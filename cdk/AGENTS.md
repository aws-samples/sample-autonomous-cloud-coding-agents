# CDK package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are an **ABCA platform engineer** for the `@abca/cdk` package: Lambda handlers, orchestration, CDK stacks and constructs, IAM, and shared API types.

## Commands (run these)

```bash
mise //cdk:compile          # TypeScript compile
mise //cdk:typecheck        # type-check src, test and scripts (jest does not check types)
mise //cdk:test             # Jest unit tests
mise //cdk:synth            # synth to cdk/cdk.out/
mise //cdk:eslint           # ESLint --fix (run after merging main)
mise //cdk:eslint:check     # ESLint without --fix: reports only; a warning fails too
mise //cdk:bootstrap:generate # regenerate cdk/bootstrap/ from src/bootstrap/ (policies JSON, template YAML, version and hash files)
mise //cdk:bootstrap        # bootstrap:generate, then cdk bootstrap --force with the least-privilege template: replaces the bootstrap it finds (requires AWS creds)
mise //cdk:preflight        # read-only: check the account's bootstrap against this checkout; deploy runs it first (requires AWS creds)
mise //cdk:deploy           # deploy stack (requires AWS creds)
mise //cdk:diff             # diff vs deployed
mise //cdk:destroy          # destroy stack
```

## Testing

- **Full suite:** `mise //cdk:test`. The coverage floors apply. They count every file in `src/`, tested or not.
- **Single file:** `mise //cdk:testf -- test/handlers/shared/validation.test.ts`
- **Pattern:** `mise //cdk:testf -- orchestrate-task`
- **Types:** `mise //cdk:typecheck`. Jest only transpiles the tests (ts-jest), so this task is what type-checks `test/` and `scripts/`. The build, `mise run lint` and the `cdk-typecheck` commit hook run it. A fixture has to match the production type it is declared with.

`testf` runs without coverage. A partial run with plain `npx jest` fails on the coverage floors after its tests pass. The full suite runs with `--ci`, which fails on a missing or changed snapshot instead of writing it. To add or update one on purpose, run `mise //cdk:testf -- -u <file>`, then commit the snapshot.

**Extend tests when you change:**

| Code | Test location |
|------|---------------|
| Shared handler logic | `cdk/test/handlers/shared/*.test.ts` |
| MicroVM-only handler logic | `src/handlers/shared/microvm/`, with tests in `test/handlers/shared/microvm/` |
| Handler entrypoints | `cdk/test/handlers/orchestrate-task.test.ts`, `create-task.test.ts`, `webhook-create-task.test.ts` |
| Constructs | `cdk/test/constructs/task-orchestrator.test.ts`, `task-api.test.ts` |
| MicroVM lifecycle transactions | `test/handlers/shared/**/*-local.test.ts`. Use a loopback DynamoDB Local endpoint in `ABCA_DDB_LOCAL_ENDPOINT` (mandatory in CI) |

In construct tests, synthesize each distinct stack config once in `beforeAll` and assert against the cached `Template`. Do not re-synth per test. Bundling is disabled globally via `test/setup/disable-bundling.ts` (see Common mistakes).

Emulator-backed tests (`test/emulator/*.emulator.ts`) run real handlers against a local AWS Emulator. `mise //cdk:test` does not run them. Use `mise run test:integration` from the repository root (needs Docker). For the rules and the known differences from AWS, see [scripts/aws-emulator/README.md](../scripts/aws-emulator/README.md).

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `cdk/src/handlers/` | WRITE | Lambda handlers |
| `cdk/src/stacks/` | WRITE | Stack definitions |
| `cdk/src/constructs/` | WRITE | Reusable constructs |
| `cdk/src/handlers/shared/types.ts` | WRITE | API types (mirror to `cli/src/types.ts`, and to `web/src/core/api/types.ts` where the console mirrors the type) |
| `cdk/src/handlers/shared/canonical-json.ts` | WRITE | Runtime receipt encoding. Preserve stored bytes and keep migration encoding separate |
| `cdk/src/bootstrap/` | WRITE | Least-privilege bootstrap: policies of the CloudFormation execution role (`policies/`), bundle version and hash (`version.ts`), bootstrap preflight (`preflight.ts`). The task entry points are `cdk/scripts/preflight-bootstrap.ts` and `cdk/scripts/generate-bootstrap-*.ts` |
| `cdk/bootstrap/` | READ only | Generated from `cdk/src/bootstrap/` by `mise //cdk:bootstrap:generate`. Commit the result and never edit it by hand |
| `cdk/test/` | WRITE | Unit and snapshot tests |
| `cli/src/types.ts` | WRITE (sync) | Must match shared types |

## Code style

**API responses.** Use `successResponse` or `errorResponse` from `shared/response.ts`. Never hand-roll JSON envelopes:

```typescript
// ✅ Good — contract envelope + typed ErrorCode
import { successResponse, errorResponse, ErrorCode } from '../shared/response';

return successResponse(200, { task_id: taskId }, requestId);
return errorResponse(422, ErrorCode.VALIDATION_ERROR, 'Invalid workflow_ref', requestId);

// ❌ Bad — ad-hoc body, no request ID
return { statusCode: 400, body: JSON.stringify({ error: 'bad' }) };
```

**Unit tests.** Colocate them under `cdk/test/` and give `describe` and `test` descriptive names:

```typescript
// ✅ Good
describe('parseBody', () => {
  test('returns null for invalid JSON', () => {
    expect(parseBody('not json')).toBeNull();
  });
});

// ❌ Bad — vague name, no edge cases
test('works', () => { expect(parseBody('{}')).toBeTruthy(); });
```

**Construct tests.** Cache the synth output:

```typescript
// ✅ Good
let template: Template;
beforeAll(() => {
  const app = new App();
  template = Template.fromStack(new MyStack(app, 'Test'));
});
```

## Boundaries

- ✅ **Always:** Update `cli/src/types.ts` when changing `shared/types.ts`, and `web/src/core/api/types.ts` where the console mirrors the type; add or extend tests in `cdk/test/`; use mise tasks, not the raw `cdk` CLI
- ⚠️ **Ask first:** New stacks or constructs, IAM policy changes, DynamoDB schema changes, enabling Lambda bundling in unit tests
- 🚫 **Never:** Bump `@cedar-policy/cedar-wasm` without bumping `cedarpy` and refreshing `contracts/cedar-parity/` fixtures; re-enable global Lambda bundling in tests; use constructor `context` for `aws:cdk:bundling-stacks` (use `postCliContext` instead, see #366)

## Common mistakes

- **API Gateway Lambda permission growth.** Pass `allowTestInvoke: false` on every new `LambdaIntegration` and keep `scopePermissionToMethod` at its default `true`. `test/synthesis/deployment.test.ts` checks permissions and template budgets across the full deployment profile product, including nested stacks.
- **Lambda bundling in unit tests.** `Template.fromStack()` synths the stack but bundling is disabled via `CDK_CONTEXT_JSON`. Do not re-enable it globally. Opt in per test with `postCliContext` only when asserting on bundle output. For details, see `test/setup/disable-bundling.ts` and #366.
- **Cedar engine drift.** `@cedar-policy/cedar-wasm` and `cedarpy` share a Rust core. Bump both and the parity fixtures in one commit. See `docs/design/CEDAR_HITL_GATES.md` §15.6 and the parity banner in `mise.toml`.
- **Coverage-ignore comment.** ESLint (`no-warning-comments`) rejects a comment that contains `istanbul ignore`, `c8 ignore`, `v8 ignore` or `node:coverage`, in `src/`, `test/` and `scripts/`. Such a comment takes code out of what the coverage floors measure. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **Types out of sync.** `cdk/src/handlers/shared/types.ts` and `cli/src/types.ts` must match. CI runs `check-types-sync` (`mise run check:types-sync`). The check also holds `web/src/core/api/types.ts` to these types as a subset mirror. The console may leave members out, but each one it declares must match. A change to the status lists in `src/constructs/task-status.ts` or to `CODING_WORKFLOW_ID` in `src/handlers/shared/workflows.ts` fails the check until the CLI and web copies follow.
- **Function above the complexity ceiling.** ESLint (`complexity`) fails any function whose cyclomatic complexity is above 40 and names it, or gives the line of an anonymous one. Every `if`, loop, `case`, `catch`, `&&`, `||`, `??`, `?:`, `?.` and default value adds one. Split the function. Do not add an `eslint-disable`. The `eslint-disable-next-line complexity` lines in `src/` mark the functions that predate the ceiling. The first number in the parenthesis of such a line is the record of its function. The function must not grow past it, and `test/eslint-config.test.ts` fails when it does, with the file, the line, the function, its value and the record. `cd cdk && ../node_modules/.bin/eslint --no-inline-config <file>` prints the current value. When a change makes the function smaller, lower the record in the same change, in the form `(56, down from 59 when it landed)`. Once such a function fits, its directive no longer applies. `mise //cdk:eslint` (`--fix`) deletes it and `mise //cdk:eslint:check` reports it as unused. Commit the deletion.
- **Import cycle.** ESLint (`import-x/no-cycle`) fails an import that leads back to its own module. `Dependency cycle detected` means the imported module imports this one. `Dependency cycle via "./b:12=>./c:7"` means it imports `./b` (written on its line 12), `b` imports `./c` (line 7) and `c` imports this one. Move what the modules need from each other into a module that imports none of them. Where only types cross, mark the import. `import type`, or `type` on each imported name, takes it out of the count. `export type … from` and `import()` stay in.
- **Trusting an L1's field type for a new service.** Generated L1s for freshly launched services often type an enum field as `string` with no documented allowed values. `tsc` and every unit test accept a wrong value. Only a real change set rejects it, and change-set *early validation* fails before the stack is touched, so there is no rollback and no runtime symptom to trace back. ADR-021 P2-F2 sent four hook route paths into `AWS::Lambda::MicrovmImage.Hooks.*` (an `ENABLED`/`DISABLED` enum) and `arm64` where `ARM_64` was required, which made the whole CDK-managed image path non-functional. Validate new-service enum fields against the equivalent CLI or API call or a throwaway change set, and pin the accepted value in a construct test.
- **Statement-level bootstrap additions still need a re-bootstrap.** Adding a statement to an existing `cdk/src/bootstrap/policies/*.ts` file changes the policy operators have *already deployed*, so it does not reach an account until `mise //cdk:bootstrap` runs again. Bump `cdk/src/bootstrap/version.ts` (MINOR), regenerate with `mise //cdk:bootstrap:generate` (policies JSON, template YAML, `BOOTSTRAP_HASH` and `BOOTSTRAP_VERSION`), and say "re-bootstrap to bundle ≥ x.y.z" in the operator-facing text. Otherwise the deploy fails with an AccessDenied that looks like a code bug. See `MicrovmPassRoles` (ADR-021 P2r2-F9, bundle 1.6.0).
- **Bootstrap artifact edited by hand.** Everything under `cdk/bootstrap/` (the policies JSON, `bootstrap-template.yaml`, `BOOTSTRAP_VERSION`, `BOOTSTRAP_HASH`) is generated. Change `cdk/src/bootstrap/` and run `mise //cdk:bootstrap:generate`. `test/bootstrap/artifact-sync.test.ts` and `test/bootstrap/bootstrap-template.test.ts` fail when a committed artifact differs from what the sources generate. A changed policy must also match its JSON block in `docs/design/DEPLOYMENT_ROLES.md` (`test/bootstrap/golden-baseline.test.ts`), and it changes the hash pinned in `test/bootstrap/__snapshots__/version.test.ts.snap`. Update the snapshot with `mise //cdk:testf -- -u test/bootstrap/version.test.ts`. A new `BOOTSTRAP_VERSION` must be mirrored in `REQUIRED_BOOTSTRAP_VERSION` of `cli/src/setup-account.ts` (`cli/test/deployment-capabilities-parity.test.ts`).
- **Test that cannot fail.** ESLint (`eslint-plugin-jest`) rejects the shapes that pass without checking anything. `fail()` does not exist in Jest. Assert the rejection (`await expect(promise).rejects.toThrow(...)`), or keep the error from the `catch` and assert after it. Every test needs an assertion: `expect`, a local helper whose name starts with `expect`, or an assertion method of `Template` or `Annotations` (`find*` returns a value and does not count). `expect(x)` needs a matcher and an async assertion must be awaited. The fake-timer idiom that keeps `expect(p).rejects…` and awaits it after advancing the timers takes `// eslint-disable-next-line jest/valid-expect -- <reason>`, because the autofix would `await` it on the spot and hang the test. No `expect` outside a test or `afterEach`, and no title twice in one `describe`.
- **Account id in a test.** The secret scan's `aws-account-id` rule (`.gitleaks.toml`) reads `test/` like any other directory. Use an AWS-published placeholder: `123456789012`, `111122223333`, `444455556666` or `000000000000`. Another 12-digit number fails the required secret scan. A UUID fixture whose last group is all digits is allowed.
- **CDK code in a Lambda bundle.** A handler that imports a module importing `aws-cdk-lib` ships the whole library in its bundle (about 57 MB). Inside `cdk/src`, handler code may import only `src/handlers/**` plus the import-free `constructs/task-status` and `constructs/task-table-indexes`. A name both sides need goes in `src/handlers/shared/` (see `storage-names.ts`), and the construct imports it from there. ESLint names the offending import (`no-restricted-imports`, `import-x/no-restricted-paths`). `test/handlers/shared/runtime-bundle-boundary.test.ts` bundles every entrypoint and is the authoritative check.
- **Un-attributed AWS SDK client (#319).** Build clients via `makeClient(Ctor, cfg)` or `makeDocClient(cfg)` from `src/handlers/shared/ua.ts`. A client built directly with `new XxxClient({})` silently drops solution attribution. ESLint rejects `new XxxClient(...)` in `src/` (`no-restricted-syntax`). It matches the name at the `new` site, so it does not see an alias or a service class without the `Client` suffix.
