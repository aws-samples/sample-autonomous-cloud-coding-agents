# CDK package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are an **ABCA platform engineer** for the `@abca/cdk` package: Lambda handlers, orchestration, CDK stacks/constructs, IAM, and shared API types.

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

- **Full suite:** `mise //cdk:test`. The coverage floors apply; they count every file in `src/`, tested or not.
- **Single file:** `mise //cdk:testf -- test/handlers/shared/validation.test.ts`
- **Pattern:** `mise //cdk:testf -- orchestrate-task`
- **Types:** `mise //cdk:typecheck`. Jest only transpiles the tests (ts-jest), so this task is what type-checks `test/` and `scripts/`; the build, `mise run lint` and the `cdk-typecheck` commit hook run it. A fixture has to match the production type it is declared with.

`testf` runs without coverage. A partial run with plain `npx jest` fails on the coverage floors after its tests pass. The full suite runs with `--ci`, which fails on a missing or changed snapshot instead of writing it: to add or update one on purpose, `mise //cdk:testf -- -u <file>`, then commit the snapshot.

**Extend tests when you change:**

| Code | Test location |
|------|---------------|
| Shared handler logic | `cdk/test/handlers/shared/*.test.ts` |
| MicroVM-only handler logic | `src/handlers/shared/microvm/`; tests in `test/handlers/shared/microvm/` |
| Handler entrypoints | `cdk/test/handlers/orchestrate-task.test.ts`, `create-task.test.ts`, `webhook-create-task.test.ts` |
| Constructs | `cdk/test/constructs/task-orchestrator.test.ts`, `task-api.test.ts` |
| MicroVM lifecycle transactions | `test/handlers/shared/**/*-local.test.ts`; use a loopback DynamoDB Local endpoint in `ABCA_DDB_LOCAL_ENDPOINT` (mandatory in CI) |

Construct tests: synthesize each distinct stack config once in `beforeAll`, assert against cached `Template` — do not re-synth per test. Bundling is disabled globally via `test/setup/disable-bundling.ts` (see Common mistakes).

Emulator-backed tests (`test/emulator/*.emulator.ts`) run real handlers against a local AWS Emulator. `mise //cdk:test` does not run them: use `mise run test:integration` from the repository root (needs Docker). Rules and known differences from AWS: [scripts/aws-emulator/README.md](../scripts/aws-emulator/README.md).

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `cdk/src/handlers/` | WRITE | Lambda handlers |
| `cdk/src/stacks/` | WRITE | Stack definitions |
| `cdk/src/constructs/` | WRITE | Reusable constructs |
| `cdk/src/handlers/shared/types.ts` | WRITE | API types (mirror to `cli/src/types.ts`, and to `web/src/core/api/types.ts` where the console mirrors the type) |
| `cdk/src/handlers/shared/canonical-json.ts` | WRITE | Runtime receipt encoding; preserve stored bytes and keep migration encoding separate |
| `cdk/src/bootstrap/` | WRITE | Least-privilege bootstrap: policies of the CloudFormation execution role (`policies/`), bundle version and hash (`version.ts`), bootstrap preflight (`preflight.ts`); the task entry points are `cdk/scripts/preflight-bootstrap.ts` and `cdk/scripts/generate-bootstrap-*.ts` |
| `cdk/bootstrap/` | READ only | Generated from `cdk/src/bootstrap/` by `mise //cdk:bootstrap:generate`: commit the result, never edit it by hand |
| `cdk/test/` | WRITE | Unit / snapshot tests |
| `cli/src/types.ts` | WRITE (sync) | Must match shared types |

## Recipes

The tables under "Where to make changes" in [../AGENTS.md](../AGENTS.md#where-to-make-changes) and in the [developer guide](../docs/guides/DEVELOPER_GUIDE.md#where-to-make-changes) say where the code is. A recipe lists what has to change together.

### Add a REST endpoint

1. The handler in `cdk/src/handlers/`, answering through `successResponse` and `errorResponse` of `cdk/src/handlers/shared/response.ts`.
2. In `cdk/src/constructs/task-api.ts`: the function with its environment and grants, its entry in `allFunctions` (the cdk-nag suppressions), and the route, with its authorizer options and `allowTestInvoke: false` on its `LambdaIntegration`.
3. The request and response types in `cdk/src/handlers/shared/types.ts`, in the mirror `cli/src/types.ts`, and in `web/src/core/api/types.ts` when the console uses them; then `mise run check:types-sync`.
4. Tests: the handler's in `cdk/test/handlers/`, the route's in `cdk/test/constructs/task-api.test.ts`.
5. The endpoint in `docs/design/API_CONTRACT.md`.
6. The resource ceiling. No template may hold more resources than `DEFAULT_BUDGETS` allows (`cdk/src/synthesis/budgets.ts`), and the root template of the widest profile is close to that. Measure it with `mise //cdk:census -- --profile additive-agentcore+ecs+lambda-microvm-widest-inline --output <new directory outside the checkout>`: the run fails above the ceiling, and `report.json` in that directory holds the count of each template. A group of endpoints therefore belongs in a nested stack, as the registry API is (`cdk/src/constructs/registry-api.ts`); a new stack is an "Ask first" change.

### Add a scheduled job

1. A construct like `cdk/src/constructs/concurrency-reconciler.ts`: the function with `ABCA_COMPONENT` in its environment, its grants, and the rule that runs it.
2. Create it in the `ConcurrencyMaintenance` nested stack of `cdk/src/stacks/agent.ts`, which keeps the jobs out of the root template. That stack holds no data: a table, bucket or secret the job needs stays in the root stack and comes in as a prop.
3. If the job has an alarm, add it to `operationalAlerts.addAlarmActions(...)` in the same file.
4. The handler in `cdk/src/handlers/`.
5. A construct test in `cdk/test/constructs/` and a handler test in `cdk/test/handlers/`.
6. The job in "Scheduled maintenance stack" of `docs/guides/DEPLOYMENT_GUIDE.md`, which names what runs there.

### Add a tracker integration

Jira is the model to read first: `cdk/src/constructs/jira-integration.ts` and the `jira-*` handlers.

1. Decide whether one is needed: a system that only starts tasks uses the signed generic webhook (`bgagent webhook create`, then `POST /v1/webhooks/tasks`). An integration is an "Ask first" change (Boundaries): it adds a construct, changes the bootstrap policy and adds an index to the task table.
2. The construct `cdk/src/constructs/<name>-integration.ts`, built from `cdk/src/constructs/integration-parts.ts` (`integrationTable`, `webhookDedupTable`, `FeedbackTracker` with `grantTrackerFeedback`) and `cdk/src/constructs/task-creation.ts` (`taskCreationEnvironment`, `grantTaskCreation`).
   - The construct id and the nesting of a table, secret or bucket never change after the first deploy: its logical ID comes from them, and under another one CloudFormation replaces the resource. Pin the new tables by logical ID in the construct's test, as `cdk/test/constructs/jira-integration.test.ts` does; `cdk/test/synthesis/legacy-state-ids.json` covers only what a stack without a profile deploys.
   - `allowTestInvoke: false` on every `LambdaIntegration`. The link route uses the API's own authorizer: the construct takes it as the prop `linkAuthorizer`, and the stack passes `cognitoAuthorizer` of `TaskApi`.
3. The stack, `cdk/src/stacks/agent.ts`: the construct behind `features.<name>`; the feature in `issueOrchestrationEnabled` when the tracker seeds epics or iterations or screens comments (that flag deploys the sweep, the heartbeat and the screening alarm the trackers share); an entry in `trackers` (the fan-out consumer and the screenshot integration take their grants from it); a `grantFeedback(fn, { writeBack })` call for every other function that writes to the tracker's issues; the stack outputs the CLI reads. `writeBack` states whether that function may store a rotated token; one that only reads tokens passes `false`.
4. The handlers, in `cdk/src/handlers/`:
   - the receiver: its own verification order and event filter, then `dedupAndDispatch` (`shared/webhook-dispatch.ts`). Build the verification from `cachedSecrets`, `hmacSha256Equals` and `verifyWithRefetch` (`shared/webhook-hmac.ts`): they make the two `isUsableHmacSecret` checks that `shared/hmac-secret.ts` asks of every new webhook source;
   - the processor: `createTaskCore` (`shared/create-task-core.ts`) with `workflow_ref: CODING_WORKFLOW_ID`, and the helpers of `shared/tracker-intake.ts` and `shared/attachment-store.ts`;
   - the link handler: a `LinkSpec` handed to `makeLinkHandler` (`shared/account-link.ts`);
   - feedback: a `Channel` adapter (`shared/orchestration-channel.ts`), its row in `shared/orchestration-channel-factory.ts` and its registry table in the `CHANNEL_REGISTRY_TABLES` of `orchestration-reconciler.ts` and `iteration-heartbeat-sweep.ts`; a dispatcher in `fanout-task-events.ts` (`NotificationChannel`, `CHANNEL_DEFAULTS`, `DISPATCHERS`);
   - the handlers that choose a tracker by name, for the features the tracker takes part in: the queue notice in `orchestrate-task.ts`, the heartbeat in `shared/iteration-heartbeat.ts` and `iteration-heartbeat-sweep.ts`, the screenshot comment in `github-webhook-processor.ts`. A grant and a registry entry alone leave them silent for the new tracker.
5. The shared places that still need an edit:
   - `ChannelSource` in `cdk/src/handlers/shared/types.ts` and its two mirrors (`mise run check:types-sync`);
   - the task-table index: its name in `cdk/src/constructs/task-table-indexes.ts`, the index in `cdk/src/constructs/task-table.ts`, and the top-level attribute that `shared/create-task-core.ts` copies out of `channel_metadata`, because an index cannot key on a nested one;
   - the feature catalog `cdk/src/deployment/features.ts` and its mirrors: `cli/src/deployment-profile.ts`, `contracts/deployment-capabilities.json` with `cli/src/deployment-capabilities.ts` (`approximateResources`: the root resources of the profile `features-<name>-inline` less those of `features-minimal-inline`), the cases in `contracts/deployment-profile-vectors/`, and the feature's row under "Deployment profiles" in `docs/guides/DEPLOYMENT_GUIDE.md`;
   - the construct id, which the names of its secrets start with, in the `SecretsManager` statement of `cdk/src/bootstrap/policies/application.ts`. That changes a deployed policy: follow **Statement-level bootstrap additions still need a re-bootstrap** and **Bootstrap artifact edited by hand** under Common mistakes;
   - the webhook route in `LARGE_BODY_WEBHOOK_PATHS` and in the path list of the rule `AWSManagedRulesCommonRuleSet` (`cdk/src/constructs/task-api.ts`), and in `largeBodyWebhookPaths` in the stack.
6. The resource ceiling per template (`DEFAULT_BUDGETS` in `cdk/src/synthesis/budgets.ts`): run the census command of the endpoint recipe before and after. The widest profile deploys a new feature only if `LEGACY_DEPLOYMENT_FEATURES` or the profile's context in `cdk/src/synthesis/profiles.ts` switches it on: until one of them does, the count leaves the tracker out, so switch it on in that context before the second run. If the root template does not fit, ask first: what goes into a nested stack has to be settled before the first deploy.
7. The CLI: `cli/src/commands/<name>.ts` ([recipe](../cli/AGENTS.md#add-a-command)), with `requireDeployedFeature` (`cli/src/feature-guard.ts`) on the command and `requireStackOutputs` (`cli/src/stack-outputs.ts`) for the outputs of step 3; its line in `FEATURE_SETUP_STEPS` (`cli/src/commands/setup.ts`), which `bgagent setup` prints as the next step; the operator's steps in a guide like `docs/guides/JIRA_SETUP_GUIDE.md`.
8. Before the pull request: the targeted tests (`mise //cdk:testf -- <name>`, and `mise //cdk:testf -- test/synthesis/deployment.test.ts`, which synthesizes every profile and whose per-feature lists need the tracker: `FEATURE_MARKERS`, the grants of an omitted tracker, the routes), the census comparison of step 6, `mise run check:deadcode`, `mise run check:types-sync`.

## Code style

**API responses** — use `successResponse` / `errorResponse` from `shared/response.ts`; never hand-roll JSON envelopes:

```typescript
// ✅ Good — contract envelope + typed ErrorCode
import { successResponse, errorResponse, ErrorCode } from '../shared/response';

return successResponse(200, { task_id: taskId }, requestId);
return errorResponse(422, ErrorCode.VALIDATION_ERROR, 'Invalid workflow_ref', requestId);

// ❌ Bad — ad-hoc body, no request ID
return { statusCode: 400, body: JSON.stringify({ error: 'bad' }) };
```

**Unit tests** — colocate under `cdk/test/`, descriptive `describe`/`test` names:

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

**Construct tests** — cache synth output:

```typescript
// ✅ Good
let template: Template;
beforeAll(() => {
  const app = new App();
  template = Template.fromStack(new MyStack(app, 'Test'));
});
```

## Boundaries

- ✅ **Always:** Update `cli/src/types.ts` when changing `shared/types.ts`, and `web/src/core/api/types.ts` where the console mirrors the type; add/extend tests in `cdk/test/`; use mise tasks not raw `cdk` CLI
- ⚠️ **Ask first:** New stacks or constructs, IAM policy changes, DynamoDB schema changes, enabling Lambda bundling in unit tests
- 🚫 **Never:** Re-enable global Lambda bundling in tests; use constructor `context` for `aws:cdk:bundling-stacks` (use `postCliContext` instead — see #366)

## Common mistakes

- **API Gateway Lambda permission growth** — Pass `allowTestInvoke: false` on every new `LambdaIntegration` and keep `scopePermissionToMethod` at its default `true`. `test/synthesis/deployment.test.ts` checks permissions and template budgets across the full deployment profile product, including nested stacks.
- **Lambda bundling in unit tests** — `Template.fromStack()` synths the stack but bundling is disabled via `CDK_CONTEXT_JSON`. Do not re-enable globally; opt in per-test with `postCliContext` only when asserting on bundle output. Details: `test/setup/disable-bundling.ts`, #366.
- **Coverage-ignore comment** — ESLint (`no-warning-comments`) rejects a comment that contains `istanbul ignore`, `c8 ignore`, `v8 ignore` or `node:coverage`, in `src/`, `test/` and `scripts/`: such a comment takes code out of what the coverage floors measure. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **Types out of sync** — `cdk/src/handlers/shared/types.ts` and `cli/src/types.ts` must match; CI runs `check-types-sync` (`mise run check:types-sync`). It also holds `web/src/core/api/types.ts` to these types as a subset mirror: the console may leave members out, but each one it declares must match. A change to the status lists in `src/constructs/task-status.ts` or to `CODING_WORKFLOW_ID` in `src/handlers/shared/workflows.ts` fails the check until the CLI and web copies follow.
- **Function above the complexity ceiling** — ESLint (`complexity`) fails any function whose cyclomatic complexity is above 40 and names it, or gives the line of an anonymous one: every `if`, loop, `case`, `catch`, `&&`, `||`, `??`, `?:`, `?.` and default value adds one. Split the function; do not add an `eslint-disable`. The `eslint-disable-next-line complexity` lines in `src/` mark the functions that predate the ceiling. The first number in the parenthesis of such a line is the record of its function: the function must not grow past it, and `test/eslint-config.test.ts` fails when it does, with the file, the line, the function, its value and the record (`cd cdk && ../node_modules/.bin/eslint --no-inline-config <file>` prints the current value). When a change makes the function smaller, lower the record in the same change, in the form `(56, down from 59 when it landed)`. Once such a function fits, its directive no longer applies: `mise //cdk:eslint` (`--fix`) deletes it and `mise //cdk:eslint:check` reports it as unused. Commit the deletion.
- **Import cycle** — ESLint (`import-x/no-cycle`) fails an import that leads back to its own module. `Dependency cycle detected` means the imported module imports this one; `Dependency cycle via "./b:12=>./c:7"` means it imports `./b` (written on its line 12), `b` imports `./c` (line 7) and `c` imports this one. Move what the modules need from each other into a module that imports none of them. Where only types cross, mark the import: `import type`, or `type` on each imported name, takes it out of the count; `export type … from` and `import()` stay in.
- **Trusting an L1's field type for a new service** — generated L1s for freshly launched services often type an enum field as `string` with no documented allowed values. `tsc` and every unit test will accept a wrong value; only a real change set rejects it, and change-set *early validation* fails before the stack is touched, so there is no rollback and no runtime symptom to trace back. ADR-021 P2-F2 sent four hook route paths into `AWS::Lambda::MicrovmImage.Hooks.*` (an `ENABLED`/`DISABLED` enum) and `arm64` where `ARM_64` was required, which made the whole CDK-managed image path non-functional. Validate new-service enum fields against the equivalent CLI/API call or a throwaway change set, and pin the accepted value in a construct test.
- **Statement-level bootstrap additions still need a re-bootstrap** — adding a statement to an existing `cdk/src/bootstrap/policies/*.ts` file changes the policy operators have *already deployed*, so it does not reach an account until `mise //cdk:bootstrap` runs again. Bump `cdk/src/bootstrap/version.ts` (MINOR), regenerate with `mise //cdk:bootstrap:generate` (policies JSON + template YAML + `BOOTSTRAP_HASH`/`BOOTSTRAP_VERSION`), and say "re-bootstrap to bundle ≥ x.y.z" in the operator-facing surface — otherwise the deploy fails with an AccessDenied that looks like a code bug. See `MicrovmPassRoles` (ADR-021 P2r2-F9, bundle 1.6.0).
- **Bootstrap artifact edited by hand** — everything under `cdk/bootstrap/` (the policies JSON, `bootstrap-template.yaml`, `BOOTSTRAP_VERSION`, `BOOTSTRAP_HASH`) is generated. Change `cdk/src/bootstrap/` and run `mise //cdk:bootstrap:generate`: `test/bootstrap/artifact-sync.test.ts` and `test/bootstrap/bootstrap-template.test.ts` fail when a committed artifact differs from what the sources generate. A changed policy must also match its JSON block in `docs/design/DEPLOYMENT_ROLES.md` (`test/bootstrap/golden-baseline.test.ts`), and it changes the hash pinned in `test/bootstrap/__snapshots__/version.test.ts.snap`: update it with `mise //cdk:testf -- -u test/bootstrap/version.test.ts`. A new `BOOTSTRAP_VERSION` must be mirrored in `REQUIRED_BOOTSTRAP_VERSION` of `cli/src/setup-account.ts` (`cli/test/deployment-capabilities-parity.test.ts`).
- **Test that cannot fail** — ESLint (`eslint-plugin-jest`) rejects the shapes that pass without checking anything. `fail()` does not exist in Jest: assert the rejection (`await expect(promise).rejects.toThrow(...)`), or keep the error from the `catch` and assert after it. Every test needs an assertion: `expect`, a local helper whose name starts with `expect`, or an assertion method of `Template` / `Annotations` (`find*` returns a value and does not count). `expect(x)` needs a matcher and an async assertion must be awaited; the fake-timer idiom that keeps `expect(p).rejects…` and awaits it after advancing the timers takes `// eslint-disable-next-line jest/valid-expect -- <reason>`, because the autofix would `await` it on the spot and hang the test. No `expect` outside a test or `afterEach`, and no title twice in one `describe`.
- **Account id in a test** — the secret scan's `aws-account-id` rule (`.gitleaks.toml`) reads `test/` like any other directory. Use an AWS-published placeholder: `123456789012`, `111122223333`, `444455556666` or `000000000000`. Another 12-digit number fails the required secret scan (a UUID fixture whose last group is all digits is allowed).
- **CDK code in a Lambda bundle** — a handler that imports a module importing `aws-cdk-lib` ships the whole library in its bundle (about 57 MB). Inside `cdk/src`, handler code may import only `src/handlers/**` plus the import-free `constructs/task-status` and `constructs/task-table-indexes`; a name both sides need goes in `src/handlers/shared/` (see `storage-names.ts`) and the construct imports it from there. ESLint names the offending import (`no-restricted-imports`, `import-x/no-restricted-paths`); `test/handlers/shared/runtime-bundle-boundary.test.ts` bundles every entrypoint and is the ground truth.
- **Un-attributed AWS SDK client (#319)** — build clients via `makeClient(Ctor, cfg)` / `makeDocClient(cfg)` from `src/handlers/shared/ua.ts`; a naked `new XxxClient({})` silently drops solution attribution. ESLint rejects `new XxxClient(...)` in `src/` (`no-restricted-syntax`); it matches the name at the `new` site, so it does not see an alias or a service class without the `Client` suffix.
