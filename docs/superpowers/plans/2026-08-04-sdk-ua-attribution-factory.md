# SDK User-Agent Attribution Factory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile PR #345 onto post-#695 `main` and route every AWS SDK client through one attributed factory, so no outbound AWS call loses ABCA solution attribution and no call site can silently omit it.

**Architecture:** Introduce a generic client factory (`makeClient`/`makeDocClient` in TS; the already-present `tenant_client`/`platform_client` in Python) as the single attributed construction path. Migrate the branch's existing spread-pattern sites (70 cdk + 33 cli) to the factory, attribute the 5 new sites `main` added since the branch point, and resolve the five open items from the 2026-07-30 review. The CI guard that *enforces* the factory is deferred to a fast-follow issue.

**Tech Stack:** AWS SDK v3 (TypeScript, cdk + cli), boto3/botocore (Python, agent), CDK Aspects, Jest, pytest/ruff, mise, prek.

## Global Constraints

- Backing issue **#319** is `approved` + P0. Branch `feat/319-sdk-user-agent-appid`. Work in the worktree `.worktrees/feat/319-sdk-user-agent-appid`.
- Solution id is the literal `uksb-wt64nei4u6` (`SOLUTION_ID`). Wire format: `app/uksb-wt64nei4u6#{stack}` (SDK-native, from `AWS_SDK_UA_APP_ID`) and `md/uksb-wt64nei4u6#{component}` (static). The three `md/` sanitizers (`cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts`, `agent/src/ua.py`) must stay byte-for-byte equivalent in charset and wire format.
- `#` is the structural separator; `md/`-label sanitizers deliberately **exclude** `#` (`UA_TOKEN_SAFE` / `_ALLOWED`). Only the CDK-only app-id builder (`buildAppId`/`sanitizeAppId`) preserves `#`.
- `APP_ID_MAX_LEN = 50` (matches botocore `USERAGENT_APPID_MAXLEN` and JS `isValidUserAgentAppId`).
- Customer opt-out must survive: `-c sdkUaAppId=''` (aspect no-op) and `AWS_SDK_UA_APP_ID=''` (CLI). The factory only ever *adds* the `md/` segment.
- Do NOT re-introduce the per-request `#{TRACE}` correlation plane (owned by X-Ray / #245).
- After merging `main`: run `mise //cdk:eslint` + `mise //cli:eslint` (both `--fix`), **commit any autofix** (CI "Fail build on mutation" rejects uncommitted lint output), then `mise run build`.
- `MISE_EXPERIMENTAL=1` is required for namespaced `mise //cdk:*` tasks.
- Acceptance test for "attribute ALL SDK calls": a census re-run reports **0 naked** `new *Client(` / `boto3.client(` / `boto3.resource(` outside the helper modules and tests.
- The design spec at `docs/superpowers/specs/2026-08-04-sdk-ua-attribution-factory-design.md` is a **local planning artifact — drop it before push** (Task 12).

---

### Task 1: Reconcile the merge onto post-#695 `main`

Bring the branch to a clean, building state on the current base. The 8 conflicts are almost all import-adjacency ("take both imports"); only `github-webhook-processor.ts` has a substantive extra client (`ddb`) and env (`TASK_TABLE`) from `main` that must also be attributed.

**Files:**
- Modify (resolve conflicts): `cdk/src/constructs/ecs-agent-cluster.ts`, `cdk/src/handlers/confirm-uploads.ts`, `cdk/src/handlers/github-webhook-processor.ts`, `cdk/src/handlers/linear-webhook-processor.ts`, `cdk/src/handlers/shared/create-task-core.ts`, `cdk/src/handlers/shared/strategies/ecs-strategy.ts`, `cdk/src/stacks/agent.ts`, `cdk/test/stacks/agent.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a merged, compiling branch on which later tasks build. The `abcaUserAgent`, `buildAppId`, `SolutionUaAspect`, `ComponentUaAspect` symbols remain importable exactly as before the merge.

- [ ] **Step 1: Fetch and start the merge**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid
git fetch origin main
git merge --no-commit --no-ff origin/main   # exits 1 with conflicts — expected
git diff --name-only --diff-filter=U          # confirm the 8 files above
```

- [ ] **Step 2: Resolve the 6 pure import-adjacency conflicts by taking BOTH sides**

For each of `linear-webhook-processor.ts`, `create-task-core.ts`, `ecs-strategy.ts`, `agent.ts`, `agent.test.ts`, and the import region of `confirm-uploads.ts`: keep HEAD's `import { abcaUserAgent } from '...'` / `import { buildAppId } from '../constructs/solution-ua-aspect'` / `import { App, AspectPriority, Aspects } from 'aws-cdk-lib'` **and** the `origin/main` imports (orchestration modules, `fs`/`path`, `StrandedOrchestrationReconciler`, extra `validation` exports). Delete only the `<<<<<<<`, `=======`, `>>>>>>>` markers. Example (`agent.test.ts`):

```ts
import * as fs from 'fs';
import * as path from 'path';
import { App, AspectPriority, Aspects } from 'aws-cdk-lib';
```

- [ ] **Step 3: Resolve `github-webhook-processor.ts` — take both, attribute main's new client**

`main` added `const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))` and `TASK_TABLE`. Resolve to keep both imports and both clients, attributing the new one:

```ts
import { isIntegrationNode } from './shared/orchestration-integration-node';
import { buildScreenshotKey, encodeMarkdownUrl, extractTaskIdFromBranch, isAllowedScreenshotUrl } from './shared/screenshot-url';
import { abcaUserAgent } from './shared/ua';

const s3 = new S3Client({ ...abcaUserAgent() });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ ...abcaUserAgent() }));
const TASK_TABLE = process.env.TASK_TABLE_NAME;
```
(Task 4 converts these spreads to `makeClient`; here just resolve + attribute so the merge builds.)

- [ ] **Step 4: Resolve `ecs-agent-cluster.ts` — keep the `buildAppId` container env block**

Keep HEAD's `sdkUaAppId` block (lines 345–353 in the conflict) and merge with any `origin/main` container-env additions. Ensure the container `environment` object retains both the `#319` `AWS_SDK_UA_APP_ID` wiring and main's `BUILD_VERIFY_TIMEOUT_S`/`ECS_PAYLOAD_BUCKET`/orchestration additions.

- [ ] **Step 5: Verify no markers remain and it compiles**

```bash
grep -rn '<<<<<<<\|>>>>>>>\|=======' cdk/src cdk/test | grep -v '====' || echo "no markers"
MISE_EXPERIMENTAL=1 mise //cdk:compile
```
Expected: no conflict markers; `cdk:compile` clean.

- [ ] **Step 6: eslint --fix (both), then commit the merge + any autofix together**

```bash
MISE_EXPERIMENTAL=1 mise //cdk:eslint
MISE_EXPERIMENTAL=1 mise //cli:eslint
git add -A
git commit -m "merge: reconcile #319 onto post-#695 main (import-adjacency + attribute new gh-webhook ddb) (#319)"
```

---

### Task 2: Build the TypeScript factory in cdk `ua.ts`

Add the single attributed constructor. TDD.

**Files:**
- Modify: `cdk/src/handlers/shared/ua.ts`
- Test: `cdk/test/handlers/shared/ua.test.ts` (add cases; file exists on branch)

**Interfaces:**
- Consumes: `abcaUserAgent(): { customUserAgent: [string, string][] }` (already exported).
- Produces:
  - `makeClient<C>(Ctor: new (cfg: any) => C, cfg?: Record<string, unknown>): C`
  - `makeDocClient(cfg?: Record<string, unknown>): DynamoDBDocumentClient`

- [ ] **Step 1: Write failing tests**

```ts
// cdk/test/handlers/shared/ua.test.ts (append)
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeClient, makeDocClient, abcaUserAgent } from '../../../src/handlers/shared/ua';

describe('makeClient', () => {
  it('spreads the md/ user-agent into the constructed client config', async () => {
    const c = makeClient(S3Client, { region: 'us-east-1' });
    const cfg = c.config;
    expect(await cfg.region()).toBe('us-east-1');           // caller opt preserved
    expect((cfg as any).customUserAgent).toEqual(abcaUserAgent().customUserAgent);
  });

  it('defaults cfg to {} when omitted', () => {
    expect(() => makeClient(S3Client)).not.toThrow();
  });

  it('makeDocClient returns an attributed DynamoDBDocumentClient', () => {
    const doc = makeDocClient({ region: 'us-east-1' });
    expect(doc).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/cdk
npx jest test/handlers/shared/ua.test.ts -t makeClient
```
Expected: FAIL — `makeClient`/`makeDocClient` not exported.

- [ ] **Step 3: Implement the factory**

```ts
// cdk/src/handlers/shared/ua.ts (append; add the lib-dynamodb import at top)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The single attributed way to construct an AWS SDK v3 client. Spreads the
 * static `md/` segment ({@link abcaUserAgent}) into the client config so
 * omission is impossible at the call site. Caller-supplied opts (region,
 * timeouts) are preserved.
 */
export function makeClient<C>(
  Ctor: new (cfg: any) => C,
  cfg: Record<string, unknown> = {},
): C {
  return new Ctor({ ...cfg, ...abcaUserAgent() });
}

/** Attributed `DynamoDBDocumentClient` — the wrapper form, in one call. */
export function makeDocClient(cfg: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeClient(DynamoDBClient, cfg));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest test/handlers/shared/ua.test.ts
```
Expected: PASS (all `ua.test.ts` incl. existing `#`-cases).

- [ ] **Step 5: Commit**

```bash
git add cdk/src/handlers/shared/ua.ts cdk/test/handlers/shared/ua.test.ts
git commit -m "feat(cdk): makeClient/makeDocClient attributed SDK factory (#319)"
```

---

### Task 3: Mirror the factory in cli `ua.ts`

**Files:**
- Modify: `cli/src/ua.ts`
- Test: `cli/test/ua.test.ts`

**Interfaces:**
- Consumes: `abcaUserAgent()` from `cli/src/ua.ts`.
- Produces: `makeClient<C>(Ctor, cfg?)` and `makeDocClient(cfg?)` with the same signatures as Task 2.

- [ ] **Step 1: Write failing tests** — identical shape to Task 2 Step 1 but importing from `../src/ua` and using a CLI-used client (`CloudFormationClient` from `@aws-sdk/client-cloudformation`).

```ts
// cli/test/ua.test.ts (append)
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { makeClient, makeDocClient, abcaUserAgent } from '../src/ua';

describe('makeClient (cli)', () => {
  it('spreads md/ UA into client config', () => {
    const c = makeClient(CloudFormationClient, { region: 'us-east-1' });
    expect((c.config as any).customUserAgent).toEqual(abcaUserAgent().customUserAgent);
  });
  it('makeDocClient is attributed', () => {
    expect(() => makeDocClient({ region: 'us-east-1' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/cli
npx jest test/ua.test.ts -t makeClient
```
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — same two functions as Task 2 Step 3, added to `cli/src/ua.ts` with `import { DynamoDBClient } from '@aws-sdk/client-dynamodb'` and `import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'`.

- [ ] **Step 4: Run to verify pass**

```bash
npx jest test/ua.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/ua.ts cli/test/ua.test.ts
git commit -m "feat(cli): makeClient/makeDocClient attributed SDK factory (#319)"
```

---

### Task 4: Migrate all cdk/src call sites to the factory + attribute the 3 new sites

Convert the 70 branch spread sites and attribute the 3 sites `main` added that the branch never saw. This makes the "zero naked clients" claim true by construction (review item 1) and makes `ABCA_COMPONENT` labels effective (review item 2).

**Files (representative — apply the pattern repo-wide across `cdk/src/handlers/**`):**
- Modify every `cdk/src/handlers/**/*.ts` that constructs a client, e.g. `confirm-uploads.ts:41-43`, `github-webhook-processor.ts:42-43`, `shared/strategies/ecs-strategy.ts`, `shared/create-task-core.ts`, `shared/orchestrator.ts`.
- Attribute the NEW sites: `cdk/src/handlers/orchestration-reconciler.ts:79`, `cdk/src/handlers/reconcile-stranded-orchestrations.ts:72`, `cdk/src/handlers/iteration-heartbeat-sweep.ts:43`.

**Interfaces:**
- Consumes: `makeClient`, `makeDocClient` from Task 2.
- Produces: zero naked `new *Client(` in `cdk/src` (excluding `ua.ts`).

- [ ] **Step 1: Convert the spread form to the factory form.** For each site, rewrite:

```ts
// before (spread, current branch)
const s3Client = new S3Client({ ...abcaUserAgent() });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ ...abcaUserAgent() }));
const lambdaClient = new LambdaClient({ ...abcaUserAgent() });
// after (factory)
const s3Client = makeClient(S3Client);
const ddb = makeDocClient();
const lambdaClient = makeClient(LambdaClient);
```
Preserve any real config: `new S3Client({ region, ...abcaUserAgent() })` → `makeClient(S3Client, { region })`. Update each file's import from `{ abcaUserAgent }` to `{ makeClient }` / `{ makeClient, makeDocClient }` (drop `abcaUserAgent` where no longer referenced; drop now-unused `DynamoDBClient`/`DynamoDBDocumentClient` imports where `makeDocClient` fully replaces them).

- [ ] **Step 2: Attribute the 3 NEW sites** (they are naked on `main`):

```ts
// orchestration-reconciler.ts:79 & reconcile-stranded-orchestrations.ts:72
const ddb = makeDocClient();                 // was DynamoDBDocumentClient.from(new DynamoDBClient({}))
// iteration-heartbeat-sweep.ts:43
const ddb = makeClient(DynamoDBClient);      // was new DynamoDBClient({})
```

- [ ] **Step 3: Census — verify zero naked clients in cdk/src**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid
grep -rnE "new (S3|DynamoDB|Bedrock[A-Za-z]*|SecretsManager|CloudFormation|STS|SFN|SQS|SNS|EventBridge|Lambda|CloudWatch[A-Za-z]*|ECS|SSM|Cognito[A-Za-z]*)Client\(" cdk/src --include='*.ts' | grep -v '.test.'
grep -rn "DynamoDBDocumentClient.from(new" cdk/src --include='*.ts' | grep -v '.test.'
```
Expected: **no output** (all routed through the factory).

- [ ] **Step 4: Compile + test + eslint**

```bash
MISE_EXPERIMENTAL=1 mise //cdk:compile
MISE_EXPERIMENTAL=1 mise //cdk:eslint
npx --prefix cdk jest   # or: MISE_EXPERIMENTAL=1 mise //cdk:test
```
Expected: clean compile, clean eslint, tests green.

- [ ] **Step 5: Commit**

```bash
git add cdk/src cdk/test
git commit -m "refactor(cdk): route all SDK clients through makeClient + attribute 3 new orchestration sites (#319)"
```

---

### Task 5: Migrate all cli/src call sites + attribute the 2 new `linear-auth-health` sites

**Files:**
- Modify every `cli/src/**/*.ts` constructing a client (33 branch spread sites: `auth.ts`, `cognito-admin.ts`, `commands/{github,jira,linear,slack}.ts`, `dynamo-clients.ts`, `github-token.ts`, `platform-doctor.ts`, `runtime-status.ts`, `stack-outputs.ts`, `webhook-test.ts`).
- Attribute NEW: `cli/src/linear-auth-health.ts:238`, `:362`.

**Interfaces:**
- Consumes: `makeClient`/`makeDocClient` from Task 3.
- Produces: zero naked AWS SDK `new *Client(` in `cli/src` (the internal `new ApiClient(...)` HTTP client is NOT an AWS SDK client — leave it).

- [ ] **Step 1: Convert spread → factory** (same rewrite rules as Task 4 Step 1), importing from `./ua` (or the correct relative path per file).

- [ ] **Step 2: Attribute the 2 new `linear-auth-health.ts` sites**

```ts
// linear-auth-health.ts:238 & :362 — was new SecretsManagerClient({ region })
const sm = makeClient(SecretsManagerClient, { region });
```

- [ ] **Step 3: Census — verify zero naked AWS SDK clients in cli/src** (exclude `ApiClient`)

```bash
grep -rnE "new (S3|DynamoDB|Bedrock[A-Za-z]*|SecretsManager|CloudFormation|STS|Cognito[A-Za-z]*)Client\(" cli/src --include='*.ts' | grep -v '.test.'
grep -rn "DynamoDBDocumentClient.from(new" cli/src --include='*.ts' | grep -v '.test.'
```
Expected: no output.

- [ ] **Step 4: Compile + test + eslint**

```bash
MISE_EXPERIMENTAL=1 mise //cli:compile
MISE_EXPERIMENTAL=1 mise //cli:eslint
npx --prefix cli jest
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/test
git commit -m "refactor(cli): route all AWS SDK clients through makeClient + attribute 2 new linear-auth-health sites (#319)"
```

---

### Task 6: Route the 2 remaining Python direct-boto3 sites through `platform_client`

The branch already routes most agent sites through `tenant_client`/`platform_client`. Two direct `boto3.client(...)` sites remain.

**Files:**
- Modify: `agent/src/config.py:416`, `agent/src/bedrock_creds_helper.py:160`
- Test: `agent/tests/test_config.py`, `agent/tests/test_bedrock_creds_helper.py` (assert the client is built via `platform_client`)

**Interfaces:**
- Consumes: `platform_client(service_name, **kwargs)` from `agent/src/aws_session.py` (already exists, attaches the `md/` UA via `_merge_ua_config`).
- Produces: zero direct `boto3.client(`/`boto3.resource(` in `agent/src` outside `aws_session.py`.

- [ ] **Step 1: Write failing test for `config.py`.** The real caller is `resolve_jira_oauth_token()` (config.py:352); the `sm = boto3.client(...)` at :416 sits *after* an in-function `import boto3` availability guard (the `try: import boto3 … except ImportError: return ""` block). Assert the client is obtained via `platform_client`, and that the graceful-skip guard still returns `""` when boto3 is unavailable:

```python
# agent/tests/test_config.py (add)
from unittest.mock import patch, MagicMock

def test_resolve_jira_oauth_token_uses_platform_client(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("JIRA_OAUTH_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:1:secret:x")
    import config
    with patch("aws_session.platform_client") as pc:
        sm = MagicMock()
        sm.get_secret_value.return_value = {"SecretString": "{}"}
        pc.return_value = sm
        config.resolve_jira_oauth_token({"secretArn": "arn:aws:secretsmanager:us-east-1:1:secret:x"})
        pc.assert_called_with("secretsmanager", region_name="us-east-1")
```
(If the enclosing function's arg shape differs, adapt the call; the assertion that matters is `platform_client("secretsmanager", …)` replaced the naked `boto3.client`.)

- [ ] **Step 2: Run to verify fail**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/agent
uv run pytest tests/test_config.py -k platform_client -x
```
Expected: FAIL — still calls `boto3.client`.

- [ ] **Step 3: Implement**

In `config.py`, `resolve_jira_oauth_token` (:416) and `bedrock_creds_helper.py` `resolve_credentials` (:160):

```python
# config.py:416 — inside resolve_jira_oauth_token, AFTER the `try: import boto3 … except ImportError: return ""` guard.
# Import platform_client alongside boto3 inside the same guard so the graceful-skip path is preserved:
#   try:
#       import boto3                      # keep — the availability probe
#       from aws_session import platform_client
#   except ImportError as e: ... return ""
sm = platform_client("secretsmanager", region_name=region)   # was: boto3.client("secretsmanager", region_name=region)
```
```python
# bedrock_creds_helper.py:160 — inside resolve_credentials
from aws_session import platform_client
resp = platform_client("sts", region_name=region).assume_role(  # was: boto3.client("sts", region_name=region).assume_role(
```
**Keep `import boto3` where it guards availability** — `platform_client` imports boto3 internally, but the in-function `import boto3` is the graceful-skip probe (see the PR's self-review note about `resolve_linear_api_token`); removing it would move the ImportError outside the guard. Only drop `import boto3` from a file if it has no remaining probe or reference.

- [ ] **Step 4: Census + run tests**

```bash
grep -rn "boto3.client\|boto3.resource" agent/src --include='*.py' | grep -v "aws_session.py" | grep -v "docstring\|# "
uv run pytest tests/test_config.py tests/test_bedrock_creds_helper.py -x
```
Expected: census shows only `aws_session.py`; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/config.py agent/src/bedrock_creds_helper.py agent/tests/test_config.py agent/tests/test_bedrock_creds_helper.py
git commit -m "refactor(agent): route remaining direct boto3 sites through platform_client (#319)"
```

---

### Task 7: Review item — `sanitizeAppId` trailing-`#` on 50-char clip

**Files:**
- Modify: `cdk/src/constructs/solution-ua-aspect.ts` (`sanitizeAppId`)
- Test: `cdk/test/constructs/solution-ua-aspect.test.ts`

**Interfaces:**
- Consumes: existing `sanitizeAppId` / `buildAppId`.
- Produces: `buildAppId(stack, override)` never returns a value ending in `#`.

- [ ] **Step 1: Failing test**

```ts
it('does not emit a trailing # when the 50-char clip lands on a separator', () => {
  const first = 'a'.repeat(49);
  const out = buildAppId('stack', `${first}#tail`);   // clip at 50 lands right after '#'
  expect(out.endsWith('#')).toBe(false);
  expect(out.length).toBeLessThanOrEqual(50);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/cdk
npx jest test/constructs/solution-ua-aspect.test.ts -t 'trailing #'
```
Expected: FAIL — output ends with `#`.

- [ ] **Step 3: Implement** — after clipping to `APP_ID_MAX_LEN`, strip a trailing separator:

```ts
// solution-ua-aspect.ts, end of sanitizeAppId/buildAppId, after the .slice(0, APP_ID_MAX_LEN)
const clipped = value.slice(0, APP_ID_MAX_LEN);
return clipped.endsWith('#') ? clipped.slice(0, -1) : clipped;
```

- [ ] **Step 4: Run to verify pass**

```bash
npx jest test/constructs/solution-ua-aspect.test.ts
```
Expected: PASS (all cases incl. existing `#`-preservation).

- [ ] **Step 5: Commit**

```bash
git add cdk/src/constructs/solution-ua-aspect.ts cdk/test/constructs/solution-ua-aspect.test.ts
git commit -m "fix(cdk): strip trailing # when app-id clip lands on separator (#319 review)"
```

---

### Task 8: Review item — `_merge_ua_config` must preserve all caller Config keys

The collision branch rebuilds `Config(user_agent_extra=combined)`, discarding any other key the caller's `Config` carried.

**Files:**
- Modify: `agent/src/aws_session.py` (`_merge_ua_config`, ~lines 261–288)
- Test: `agent/tests/test_aws_session.py`

**Interfaces:**
- Consumes: `ua.static_user_agent_extra()`.
- Produces: `_merge_ua_config` returns a `Config` that preserves the caller's non-UA keys AND concatenates both UA extras.

- [ ] **Step 1: Failing test**

```python
def test_merge_ua_config_preserves_other_caller_config_keys():
    from botocore.config import Config
    import aws_session
    caller = Config(read_timeout=7, connect_timeout=3, user_agent_extra="caller/1.0")
    merged = aws_session._merge_ua_config({"config": caller})["config"]
    assert merged.read_timeout == 7
    assert merged.connect_timeout == 3          # <-- dropped today
    assert "caller/1.0" in merged.user_agent_extra
    assert "md/uksb-wt64nei4u6#agent" in merged.user_agent_extra
```

- [ ] **Step 2: Run to verify fail**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/agent
uv run pytest tests/test_aws_session.py -k preserves_other_caller -x
```
Expected: FAIL — `connect_timeout` is None.

- [ ] **Step 3: Implement** — merge the combined UA into a *copy* of the caller Config rather than a fresh one:

```python
# aws_session.py, collision branch of _merge_ua_config
caller_extra = getattr(existing, "user_agent_extra", None)
if caller_extra:
    combined = f"{caller_extra} {ua.static_user_agent_extra()}"
    # Preserve every other caller key: merge the combined UA onto the caller's
    # own Config (Config.merge lets the argument win, so the argument carries
    # only the UA we want to override).
    kwargs["config"] = existing.merge(Config(user_agent_extra=combined))
    return kwargs
```

- [ ] **Step 4: Run to verify pass**

```bash
uv run pytest tests/test_aws_session.py
```
Expected: PASS (incl. existing concat + no-collision tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/aws_session.py agent/tests/test_aws_session.py
git commit -m "fix(agent): _merge_ua_config preserves all caller Config keys (#319 review)"
```

---

### Task 9: Review item — tighten the synth-coverage test

Replace the loose `/CustomResourceProviderHandler/` filter (catches 2 of 3 framework Lambdas) and `toBeGreaterThan(10)` with an explicit framework-id allowlist and an exact count of ABCA-authored Lambdas (updated for #695's new orchestration Lambdas).

**Files:**
- Modify: `cdk/test/stacks/agent.test.ts` (the `AWS_SDK_UA_APP_ID` nested-scope coverage test)

**Interfaces:**
- Consumes: the synthesized agent stack template.
- Produces: a test that fails if any ABCA-authored Lambda lacks `AWS_SDK_UA_APP_ID`, and fails if the ABCA Lambda count drifts.

- [ ] **Step 1: Enumerate the framework-owned logical-id prefixes and current ABCA Lambda count**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/cdk
# list every Lambda in the synthesized agent stack to derive the exact count + framework ids
npx jest test/stacks/agent.test.ts -t 'AWS_SDK_UA_APP_ID' --verbose 2>&1 | head -40
```
Record the framework-owned ids: `CustomResourceProviderHandler*`, `CustomS3AutoDeleteObjects*`, `CustomVpcRestrictDefaultSG*`, and the `AWS679f53fac002430cb0da5b7982bd2287*` `cr.AwsCustomResource` singleton.

- [ ] **Step 2: Rewrite the assertion with an explicit allowlist + exact count**

```ts
const FRAMEWORK_LAMBDA_ID = /^(CustomResourceProviderHandler|CustomS3AutoDeleteObjects|CustomVpcRestrictDefaultSG|AWS679f53fac002430cb0da5b7982bd2287)/;
const lambdas = template.findResources('AWS::Lambda::Function');
const abcaLambdas = Object.entries(lambdas).filter(([id]) => !FRAMEWORK_LAMBDA_ID.test(id));

// exact count — fails if an integration construct is dropped OR a new Lambda is unattributed
expect(abcaLambdas.length).toBe(EXPECTED_ABCA_LAMBDA_COUNT);   // set from Step 1
for (const [id, res] of abcaLambdas) {
  const env = res.Properties?.Environment?.Variables ?? {};
  expect(env.AWS_SDK_UA_APP_ID, `${id} missing AWS_SDK_UA_APP_ID`).toBeDefined();
}
```
Set `EXPECTED_ABCA_LAMBDA_COUNT` to the number observed in Step 1 (document it inline: "update when adding/removing a Lambda construct").

- [ ] **Step 3: Run to verify pass**

```bash
npx jest test/stacks/agent.test.ts -t 'AWS_SDK_UA_APP_ID'
```
Expected: PASS with the exact count; flipping any Lambda to naked (temporarily) fails it.

- [ ] **Step 4: Commit**

```bash
git add cdk/test/stacks/agent.test.ts
git commit -m "test(cdk): exact-count + framework-allowlist for UA synth coverage (#319 review)"
```

---

### Task 10: Verify `ABCA_COMPONENT` labels now land + add per-surface label tests

Tasks 4/5 made the Jira and api-key handlers build via the factory, so the `webhook`/`api` labels now appear in a real `md/` segment (closes review item 2). Add tests that prove the label lands.

**Files:**
- Test: `cdk/test/handlers/shared/ua.test.ts` (component-label behavior via `ABCA_COMPONENT`)

**Interfaces:**
- Consumes: `abcaUserAgent()` (reads `process.env.ABCA_COMPONENT`).
- Produces: tests asserting the emitted `md/` value per surface.

- [ ] **Step 1: Write the label tests**

```ts
describe('component label lands in the md/ segment', () => {
  afterEach(() => { delete process.env.ABCA_COMPONENT; });
  it('emits md/…#webhook when ABCA_COMPONENT=webhook', () => {
    process.env.ABCA_COMPONENT = 'webhook';
    expect(abcaUserAgent().customUserAgent).toEqual([['md/uksb-wt64nei4u6', 'webhook']]);
  });
  it('falls back to api when unset', () => {
    expect(abcaUserAgent().customUserAgent).toEqual([['md/uksb-wt64nei4u6', 'api']]);
  });
});
```

- [ ] **Step 2: Run to verify pass** (behavior already present; this locks it)

```bash
cd .worktrees/feat/319-sdk-user-agent-appid/cdk
npx jest test/handlers/shared/ua.test.ts -t 'component label'
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cdk/test/handlers/shared/ua.test.ts
git commit -m "test(cdk): assert ABCA_COMPONENT label lands in md/ segment (#319 review)"
```

---

### Task 11: Docs — factory note in AGENTS.md + PR description rewrite

**Files:**
- Modify: `AGENTS.md` (Common mistakes / #319 note), `cdk/AGENTS.md`, `cli/AGENTS.md`, `agent/AGENTS.md` (one line each)
- No `docs/guides` or `docs/design` prose change → no Starlight sync needed (verify).

**Interfaces:** none (docs).

- [ ] **Step 1: Update the root AGENTS.md #319 note**

Replace the existing condensed bullet with the factory rule:

```md
- **Un-attributed AWS SDK client** — construct clients via the attributed factory:
  `makeClient(Ctor, cfg)` / `makeDocClient(cfg)` (TS: `cdk/src/handlers/shared/ua.ts`,
  `cli/src/ua.ts`) or `tenant_client` / `platform_client` (Python: `agent/src/aws_session.py`).
  A naked `new XxxClient({})` / `boto3.client(...)` silently loses solution attribution (#319).
```

- [ ] **Step 2: Add a one-line pointer in each package AGENTS.md** (cdk/cli/agent) to the factory in that package.

- [ ] **Step 3: Confirm no generated-mirror sync needed**

```bash
git diff --name-only origin/main -- docs/guides docs/design CONTRIBUTING.md | grep . && echo "SYNC NEEDED: run mise //docs:sync" || echo "no guide/design prose changed — no sync"
```

- [ ] **Step 4: Rewrite the PR #345 description** — drop the false "zero naked clients remain" claim; state that all sites now route through the factory; reduce "Honest coverage gaps" to the genuine cases (CDK framework-owned CR-provider Lambdas). Save to a scratch file and update via `gh pr edit 345 --body-file`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md cdk/AGENTS.md cli/AGENTS.md agent/AGENTS.md
git commit -m "docs: factory is the attributed SDK client construction path (#319)"
```

---

### Task 12: Final verification gates, drop the spec, push

**Files:**
- Remove: `docs/superpowers/specs/2026-08-04-sdk-ua-attribution-factory-design.md` and `docs/superpowers/plans/2026-08-04-sdk-ua-attribution-factory.md` (local artifacts — drop before push).

- [ ] **Step 1: Full census acceptance test (all three packages)**

```bash
cd .worktrees/feat/319-sdk-user-agent-appid
grep -rnE "new (S3|DynamoDB|Bedrock[A-Za-z]*|SecretsManager|CloudFormation|STS|SFN|SQS|SNS|EventBridge|Lambda|CloudWatch[A-Za-z]*|ECS|SSM|Cognito[A-Za-z]*)Client\(" cdk/src cli/src --include='*.ts' | grep -v '.test.'
grep -rn "DynamoDBDocumentClient.from(new" cdk/src cli/src --include='*.ts' | grep -v '.test.'
grep -rn "boto3.client\|boto3.resource" agent/src --include='*.py' | grep -v "aws_session.py" | grep -vE "^\s*#|\"\"\""
```
Expected: **all three empty** (the acceptance criterion for "attribute ALL SDK calls").

- [ ] **Step 2: eslint --fix both + commit any mutation**

```bash
MISE_EXPERIMENTAL=1 mise //cdk:eslint
MISE_EXPERIMENTAL=1 mise //cli:eslint
git diff --quiet || { git add -A && git commit -m "chore: eslint --fix mutations (#319)"; }
```

- [ ] **Step 3: Full build + package suites + security**

```bash
MISE_EXPERIMENTAL=1 mise run build
MISE_EXPERIMENTAL=1 mise //cdk:test
MISE_EXPERIMENTAL=1 mise //cli:test
MISE_EXPERIMENTAL=1 mise //agent:quality
mise run security:sast
mise run security:secrets
```
Expected: all green (note: the known `//cdk:synth` AZ-lookup creds gap is pre-existing/out-of-scope; `compile`+`test` cover synth logic).

- [ ] **Step 4: Drop the local planning artifacts**

```bash
git rm docs/superpowers/specs/2026-08-04-sdk-ua-attribution-factory-design.md \
       docs/superpowers/plans/2026-08-04-sdk-ua-attribution-factory.md
git commit -m "chore: drop local planning artifacts before push (#319)"
# if docs/superpowers/ is now empty, git rm leaves no dir — nothing else to clean
```

- [ ] **Step 5: Push and reply to the review**

```bash
git push origin feat/319-sdk-user-agent-appid
```
Then reply in-thread to theagenticguy's 2026-07-30 review points (each maps to a task above), and re-request review. File the fast-follow **CI-guard** issue (see spec "Prevention: the fast-follow") and link it from the PR.

---

## Fast-follow (separate `approved` issue + PR — NOT this plan)

Per the spec: `scripts/check-ua-coverage.mjs` (modeled on `scripts/check-types-sync.ts`) wired into `mise.toml` `drift-prevention` + prek hook; ESLint `no-restricted-syntax` `NewExpression[callee.name=/Client$/]` in both TS configs with a helper-file override; Python via ruff `flake8-tidy-imports` banned-api or a `.semgrep/` rule (gives the `# nosemgrep` allowlist). This PR builds the factory; the guard enforces it.
