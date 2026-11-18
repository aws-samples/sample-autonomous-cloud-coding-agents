# AWS Emulator for local and CI tests

**Status:** adopted as an advisory check. This is the investigation as it was handed over on 2026-11-15: unless a sentence says otherwise, it describes the proof of concept (then uncommitted, in a worktree of this branch) and `main` (`c8fcdb08`) as they stood that day. What was decided and done afterwards is in [Outcome](#outcome). The rules for tests in the tier and the list of known differences from AWS are maintained in [`scripts/aws-emulator/README.md`](../../scripts/aws-emulator/README.md), not here.
**Date:** 2026-11-15
**Emulator version examined:** 1.0.385 (`aws/aws-emulator`, commit `813af48`)

## Summary

Adopt the [AWS Emulator](https://github.com/aws/aws-emulator) as ADR-013's Tier 2a (container integration tests, between the local unit build and remote CI), which the ADR marks "does not exist". Use it in one way: ABCA's real handler, CLI and agent code runs in its normal test runner, and only its AWS SDK calls go to an emulator on loopback. Run it with `mise run test:integration` and as an advisory check on every pull request.

What the investigation established:

| Question | Answer |
|---|---|
| Does ABCA code run against it? | Yes, with no change to product code. The proof of concept has 58 tests across `cdk`, `cli` and `agent` and runs in about 24 seconds on a laptop, emulator start and stop included. |
| Does it find things the mocked suites cannot? | Yes. It reproduced open issues #51 and #1003, and execution on it confirmed three defects around approval gates that no issue tracks (see [Defects found](#defects-found-during-the-investigation)). |
| How much of ABCA's defect history would it have caught? | About one in twelve of the 120 recorded defects that passed unit tests and were found on a live stack (10 on a second reader's count, 13 on the first). More than half needed real AWS and still would. |
| Can it replace the real-AWS integ smoke? | No. IAM, deployment of the full platform, and the AgentCore runtime are outside what it can show. |
| What does it cost? | Docker wherever the tier runs, a 1.08 GB image built once per version in 16 seconds, about 390 lines of tooling (the proof of concept adds about 2,200 lines of tests and harness), an estimated 3 minutes per pull request in CI, and a pinned version that someone has to move. |
| What is not verified? | The workflow has never run on GitHub, the suites have run on macOS only, and nothing was compared with real AWS (see [Costs and risks](#costs-and-risks)). |

Three things this proposal does not recommend: deploying stacks to the emulator as a test tier, making the check required from day one, and running handlers inside the emulator's own Lambda. The reasons are in [Deploying to the emulator](#deploying-to-the-emulator) and [Rollout](#rollout).

## Outcome

The owner read this report on 2026-11-15 and decided: adopt the tier as an advisory check, implement it on one branch for one pull request, fix the defects below that no open pull request already addresses, and add the workflow of Appendix A.

The main things that pull request adds to the proof of concept described in the rest of this document:

- `.github/workflows/emulator.yml`, exactly as in [Appendix A](#appendix-a-workflow).
- Tests of the guard's refusals in the unit suites, so that a guard that stops refusing fails the required build: `cdk/test/scripts/aws-emulator-guard.test.ts` and `agent/tests/test_emulator_guard.py`.
- `scripts/aws-emulator/README.md` (how to run the tier, its rules, the known differences), which also covers what the README criterion of issue #61 asks for, at another path; lines in the four `AGENTS.md` guides; and the amendment of ADR-013.
- The fixes in the two tables below. Each fix that changes behaviour has a unit test that fails without it (the one about numbers stored as strings changes comments and types only, and is checked by the compiler), and where an emulator test witnessed the defect it is now a plain test. The emulator suites then hold 12 `cdk` tests (2 still `test.failing`, both waiting for PR #1009), 7 `cli` tests (1 `test.failing`, an emulator gap, until the pin moved: see the end of this section) and 43 agent tests.

| Defect (details under [Defects found](#defects-found-during-the-investigation)) | Outcome |
|---|---|
| The stranded-approval sweep measures from the start of `RUNNING` | Fixed: the agent's two approval transitions write `status_created_at`. The TypeScript writer that open PR #1013 adds needs the same attribute |
| A task resumed after a long approval wait is failed as "Agent session lost" | Left to open PR #904 |
| The concurrency reconciler counts four statuses; #1003 | Left to open PR #1009 |
| A never-configured GitHub token secret is reported as configured | Fixed in the CLI: a token is recognised by GitHub's formats, and `github set-webhook-secret` no longer guesses whether a secret is set |
| A session role that cannot be assumed does not abort the task | Fixed: the role is assumed when the session is first built, so the task stops before any work. The price is that an STS failure at task start that outlasts the SDK's retries now fails the task. When the role can never be assumed the user still reads "Agent session lost", because the agent has no credentials to record the reason |
| The trajectory writer never retries stream creation | Fixed |
| #51: list order and the empty filtered page | Fixed: a new index `UserCreatedAtIndex` on the task table, read until the page is full. The next deployment creates and backfills the index; on an existing stack the handler asks DynamoDB for the status of the new index and reads the old one, in its old order, until that status is `ACTIVE` (see "Known deployment issues" in the deployment guide) |
| `integ.yml` is blocked by its own concurrency group | Fixed on `main`: #1035 moved the group from the workflow to the `integ` job, and #1047 keyed it by pull request, so that runs of different pull requests no longer cancel each other (#1046). `integ.yml` and ADR-013 now also say that `integ-smoke` is not a required check. Whether `integ-smoke` becomes required is a ruleset setting and is open |
| `upgrade-main` has failed since 2026-08-19 | Not a defect of a tracked file: the token in the repository secret `AUTOMATION_GITHUB_TOKEN` stopped being accepted. Open; it needs a new token |
| The Slack cancel button writes less than `cancel-task` | Fixed: it writes `completed_at` and `status_created_at` |
| `task_cancelled` is recorded twice | Left: both writers are needed and every consumer tolerates the repeat |
| `bgagent ops stuck-tasks` ages tasks by creation time | Fixed: it ages by time in the current status, as the reconciler does |
| Numbers stored as strings while the comments blame the SDK | Fixed: `numeric.ts`, `TaskRecord` and the comments that cite them say what is stored, in the handlers and in their tests. One comment in `fanout-task-events.ts` is left as it is: it sits in a block that open PR #991 moves, and changing it here would make that pull request conflict there |
| The agent unit suite depends on test order | Fixed |

Found while fixing, and not listed further down:

| Defect | Outcome |
|---|---|
| `GET /v1/webhooks` applies its filter after `Limit`, as #51 did | Fixed |
| The confirm-uploads Lambda never receives the per-user cap, and admits against a fallback of 3 where the stack sets 10 | Fixed. Until open PR #1009, a confirmed attachment task still holds two seats, so the limit met on that path stays below the cap |
| The presign-failure path of `create-task` fails a task without `completed_at`, a matching `status_created_at` or a `ttl` | Fixed |
| `bgagent ops concurrency` prints a default limit of 3 where the stack deploys 10, and six documents said 3 or "3-5" | Fixed. The user guide and the API contract also said that a task over the limit fails; since #441 it is queued, and they now say so. Four more documents named the event that #441 removed (`admission_rejected`), and two examples showed a task failed at the limit; they are corrected too |
| The `integ` job's command has been unrunnable since #567: it passes `cdk deploy` arguments to `integ-runner`, which exits 1 | Fixed: the job runs `mise //cdk:integ` with nothing after it, and a unit test fails when the workflow passes the task an argument. The job has not run with the fix: it needs the `deploy` approval, and until this merges an approved run still uses `main`'s copy of the workflow |
| `auto-approve` cannot approve the pull requests `upgrade-main` opens, because one token does both | Open |
| `upgrade-main.yml` reports a patch that `git apply` refuses as "Empty patch. Skipping.", and the run ends green | Open |
| `GET /v1/pending` lists an approval request whose window has passed until DynamoDB deletes the row | Open, tracked as #1043; PR #904 changes how the wait works |
| Comments and a test title describe the Linear webhook dedup as 60 seconds on issue and action; the handler keeps eight hours on the delivery's id (an issue or a comment), action and timestamp | Fixed (comments only) |
| A task that times out in the admission queue is shown as "Unexpected error": its message says "concurrency slot" and the classifier looks for "concurrency limit" | Open. Whether it should be classed as a concurrency error, which is retryable, is a product decision |
| `AgentStack` passes its per-user cap to the orchestrator and the reconcilers but not to `TaskApi` or `AdmissionQueuePickup`, which use a default of their own | Open, tracked as #1044. No effect while the constant and both defaults are 10 |
| Two more writers of a terminal status omit an attribute: `reconcile-stranded-tasks.ts` writes no `ttl`, `confirm-uploads.ts` no `completed_at` | Fixed: each write sets the missing attribute. Open PR #1009 changes both files, but neither write |

PR #1035 merged on 2026-11-16 (UTC), after the hand-over, and the pull request was rebased onto it. Where the rest of this document calls #1035 open, or describes `dead-code-pr.yml`, it describes the day of the hand-over: #1035 replaced that workflow with a zero-tolerance dead-code check in the build. The pull request carries the seven `knip.json` entries that [Fit with pull request #1035](#fit-with-pull-request-1035) found it would need, and the mise version that every workflow which installs mise now pins, in `emulator.yml` and in Appendix A.

What [Costs and risks](#costs-and-risks) lists as not verified still was when the pull request was opened, with three exceptions:

- The tier has since run on Linux. On arm64, in an Ubuntu 24.04 container with its own Docker daemon, `mise run test:integration` built the image through `emulator.sh up`, passed the three suites and stopped the emulator, four runs out of four, and the two guard suites passed there as well. These runs were made before the rebase onto #1035; the rebased tree had then run on macOS only. The `linux/amd64` package was built into an image, and the three suites passed against that emulator under emulation. No test process had run on x86_64, and the workflow had not run on GitHub.
- The pull request is rebased onto #1035, and `mise run build` passes there with the gates #1035 added, which this investigation had only simulated one by one.
- A red check that is not required does not hold the merge queue: `dead-code-pr` failed on the merge groups of #664 and #665 on 2026-08-12, and both merged.

After the pull request was opened:

- Its workflow ran on GitHub for the first time and passed: a GitHub-hosted x86_64 runner built the image and ran the 62 tests, in three minutes for the job. That is the first test process on x86_64 and the first run of the workflow.
- The pin moved from 1.0.385 to 1.0.481, the second release published after it. The suites showed two changes, both in Cognito and both made by release 1.0.471: `RespondToAuthChallenge` for `NEW_PASSWORD_REQUIRED` is implemented, so the `cli` test of the first sign-in is a plain test and no `test.failing` waits for an emulator gap; and the `iss` claim of a token names the emulator again, as it did on 1.0.367. The README's table of differences and its lists of what does not work were then probed again on both releases. More had changed with no test to show it: `UpdateRegistryRecordStatus` is implemented, the four agent-registry answers parse in the JavaScript SDK, `DeleteRegistry` refuses a registry that holds records, a write that changes nothing emits no stream record, fewer malformed expressions are accepted, and other containers can reach the ports the emulator opens for resource endpoints. That table and those lists are current for 1.0.481; where this document describes the emulator, it describes 1.0.385. When the pin moved, 1.0.481 had run on macOS only.

## What the emulator is

An AWS-published local emulator of the AWS APIs: one Rust process that serves every service on a single HTTPS endpoint. The points that matter for this proposal:

- **Distribution.** Signed `.deb` and `.rpm` packages for Linux on x86_64 and aarch64. AWS publishes no container image; on macOS it runs in Docker from a short Dockerfile.
- **Wire contract.** HTTPS on loopback with a certificate created at each start, and SigV4 signatures required with credentials created at each start. Both SDKs ABCA uses reach it through environment variables alone (`AWS_ENDPOINT_URL`, a credentials file, a CA bundle).
- **State.** In memory. There is no reset call; restarting is the reset. Start to healthy takes under a second and an idle instance uses about 180 MiB.
- **Unimplemented operations are explicit.** They answer HTTP 501 `NotImplemented` instead of an empty success. Two other kinds of gap are silent: four agent-registry operations return bodies the JavaScript SDK cannot parse, and four CloudFormation resource types report `CREATE_COMPLETE` and create nothing (see [Deploying to the emulator](#deploying-to-the-emulator)).
- **Maturity.** Very young. Its first GitHub release is dated 2026-11-07 and its first issue 2026-11-11; three days after that it had 417 open issues. There were 30 releases between 2026-11-07 and 2026-11-14, nine of them on the last day.
- **Stated limits.** AWS says not to use it to test security, that one instance is one account and one Region, and that fidelity is strongest for control-plane APIs.

The alternatives ADR-013 names were not evaluated in depth. LocalStack's documentation says an auth token is mandatory to start its container, which means a CI secret and no runs for fork pull requests. moto has a standalone server mode that a Node process can also use and is the mature community option. DynamoDB Local, which the repository already uses for local agent runs, covers DynamoDB only.

## What was built and measured

The proof of concept is in the worktree and runs with one command. Every suite uses real product code and no SDK mock.

| Suite | What runs for real | Tests | Time |
|---|---|---|---|
| `cdk/test/emulator` | The `create-task`, `get-task`, `list-tasks`, `cancel-task`, `get-task-events` and `reconcile-concurrency` handlers and the orchestrator's admission and finalize functions, on tables created from the CDK table constructs | 11, of which 4 are known-defect witnesses (jest `test.failing`: the test states the correct behavior and is green only while it still fails) | 5 s |
| `cli/test/emulator` | `configure --stack-name`, login, token refresh and change-password against a Cognito pool created through emulated CloudFormation. The fixture stack is written by hand to match the `TaskApi` construct as it is today | 5, of which 1 is a `test.failing` that marks an emulator gap | 2 s |
| `agent/tests_emulator` | Progress events, trace upload, secret resolution, CloudWatch Logs writes, the tenant-scoped session (a real `AssumeRole` with session tags), the approval transactions, and the round trip issue #61 asks for: the Python agent uploads a trace, the TypeScript `get-trace-url` handler presigns it, the real `bgagent trace download` fetches and gunzips it. The CLI runs in API-key mode against a stand-in for API Gateway and its authorizer, so its login path is not part of the round trip | 42 | 12 s |

How this was checked. The investigation was run by AI agents in three rounds: investigators built the suites and the probes, verifiers repeated each claim with scripts of their own, and reviewers checked the final tree and this document. Everywhere else in this document, "agent" means ABCA's coding agent. Verifiers ran the first version of each suite between 16 and 23 times on fresh instances, serially, in parallel, in random order and with three sessions sharing one emulator, with no failure. The suites were then restructured twice in response to verifier and reviewer findings (see [Fit with pull request #1035](#fit-with-pull-request-1035) and [Keeping the tier away from real AWS](#keeping-the-tier-away-from-real-aws)). On the final version `mise run test:integration` passed five times in a row (21.6 to 25.2 seconds each) with a scratch state directory, and again with no overrides from a login shell that exports a real AWS profile. Each `test.failing` was run once as a plain `test`: the four `cdk` ones fail on their final assertion, and the `cli` one fails at the 501 it documents. The numbers that shape the design:

- A new DynamoDB table is unusable for a fixed 3.0 seconds (a constant in the emulator, not configurable). Tables created together share one wait, so the cost is 3 seconds per test file, which is about 70% of a file's run time.
- One DynamoDB call from jest to the emulator in Docker on macOS takes about 2 ms.
- The round trip for issue #61 takes 6.8 seconds for six tests. A change to the handler alone (adding `ResponseContentEncoding: 'gzip'` to the presigned request) passes the handler's 25 unit tests and the agent's trace tests and fails three round-trip tests.

Known limits of the proof of concept itself:

- The agent suite's table key schemas and session-role policy are copied by hand from the CDK constructs. They match today for what the tests use: the three key schemas, and the DynamoDB, trace and artifact statements of the session role. The construct's attachment-read and Bedrock statements are not mirrored, and the test role trusts the account root where the construct trusts the compute role. Nothing fails if a construct changes.
- Rule 1 below (rows come from the real writer) is not followed everywhere. Besides those copies and the CLI's hand-written fixture stack, three kinds of row are written by the tests themselves: the repo row `create-task` gates on (`task-api.emulator.ts`), the `AWAITING_APPROVAL` status in the reconciler witness (`concurrency-seats.emulator.ts`), and every task row in the agent suite.
- `concurrent cancels` in `task-api.emulator.ts` is an outcome test. Depending on timing a losing cancel is refused by the handler's read or by its conditional write, and the test passes either way, so it cannot detect a missing condition. `racing admissions` in `concurrency-seats.emulator.ts` can.
- The agent test of the approval transition passes over two of the defects listed below, because its task row has two attributes and its tables have no indexes.
- The agent suite inherits agent variables from the calling shell. With `AGENT_SESSION_ROLE_ARN` exported, tests that expect the unscoped path fail (seen on an earlier version of the suite); the unit conftest clears 19 such variables and this suite clears none.

## What it is worth

### Against ABCA's own history

One investigator built a ledger of 120 defects whose own record (commit body, issue or pull request) says they passed unit tests and were found on a deployed stack. A second reader independently re-classified 48 of them, including every one counted in favor of the emulator, and agreed on 42. The table gives the second reader's tally; the first counted 13 in the top row.

| Where the defect could have been caught | Count | Share |
|---|---|---|
| An emulator-backed test (data-plane behavior, or state shared between the Python agent and the TypeScript handlers) | 10 | 8% |
| A deployment to the emulator | 2 | 2% |
| Only real AWS: IAM and bootstrap policies (21), Lambda, AgentCore and MicroVM runtime behavior (22), CloudFormation deployment, model behavior, service quirks | 62 | 52% |
| Only a real third party or the real container image | 9 | 8% |
| A unit or synth test | 37 | 31% |

Three cautions. The most generous reading of the same ledger gives 18 of 120. The 120 are a selection, not a census: six of the source commits contain at least twelve more live-found defects that are not in the ledger, none of them catchable on an emulator, so the true share is somewhat lower. And "would have caught" assumes someone had written the test that drives the real code path.

The catchable defects share a profile: they are silent, and they recur. A filter applied after `Limit` appeared five times between April and November (#51, still open; #579; #681; #831; #987). Approval gates that denied everything, a workspace reported as not onboarded, and webhooks that answered 401 forever are in the same group.

### Against the CI record

ADR-013 (status: proposed) says a Tier 2a would eliminate "60%+ of CI-only failures (AWS API contract mismatches)". The record does not support that sentence. `build.yml` has no credentials and makes no AWS call. Of the 62 failed build logs that were read (all 50 human-authored ones still available, and 12 Dependabot ones), none shows a request to AWS; the failures are unit tests, type checks and lint. Thirty-one of them do show agent unit tests reaching the boto3 CloudWatch Logs client and stopping at `NoRegionError`: the build makes no AWS call because the runner has no Region or credentials, not because the unit suite is hermetic.

The comparison that matters is with the real-AWS integ smoke, and the record there is this: its test step has executed once in CI, on 2026-07-07, and passed. Since then `integ.yml` has been blocked by its own workflow-level concurrency group: a run waiting for `deploy` environment approval holds the group, and each newer run is cancelled in the queue. Between 2026-07-07 and 2026-11-15 the group was held by an approval wait for 122 of 130 days and 1,194 of 1,241 runs were cancelled, all but one before any job started, so not even the green "skipped" status is posted. One pull request that changes `cdk/` and `agent/` (#909) merged with no `integ-smoke` status on its head, and `integ-smoke` is not among the required status checks. In practice the emulator tier would not run before the integ tests; it would be the only automated check of AWS behavior on a pull request.

### Demand that already exists in the repository

- Three open pull requests (#1009, #1013, #904) each add a suite that needs a real conditional-write engine, gated on a DynamoDB Local endpoint. On `main` nothing provides one, so they skip or fail in CI. #904 itself adds a pinned `amazon/dynamodb-local` service container to the `build` job and hands its endpoint to the build step, and #1009's description relies on that.
- Hand-written in-memory DynamoDB fakes, about 300 lines in `cdk/test/integration` (two files) and one handler test. They match conditions by substring, ignore `Limit` and filters, and return whole items from every index. One of them, in `orchestration-e2e.test.ts`, drops the conditional claim write (`child_status = :releasing`) that the child-release path in `orchestration-release.ts` relies on to release a child once, so in the fake a second releaser also passes. (This is the orchestration release already on `main`, not the seat release of PR #1009.)
- The source contains at least 46 distinct `ConditionExpression` forms and 64 `UpdateExpression` forms. Only one of them, the `attribute_not_exists(task_id)` put in `create-task`, is ever evaluated by a real DynamoDB engine before production, in the real-AWS integ smoke; no update expression and no query is.

## Where a green run can be trusted

The investigation ran 353 checks shaped like ABCA's real calls against the emulator; 302 behaved as AWS documents, and the differences that set the scope below were probed again independently.

| Trust a green run for | Do not use the tier for |
|---|---|
| DynamoDB: conditions, update expressions, transactions with per-item cancellation reasons, index keys and projections, `Limit` before filter, pagination including the 1 MB page, reserved words | Permissions of any kind. A missing grant is invisible; identity policies are evaluated in some paths and not others |
| S3 objects: put, get, head, delete, versions, presigned GET | Presigned POST policy enforcement (see below) |
| Secrets Manager: version stages, delete then restore, the error names and the one message text ABCA matches | Deployment correctness of the platform stack |
| Cognito: admin user operations, password login, refresh, change password, token claims | First-login password rotation, the hosted UI, MFA |
| STS: `AssumeRole` with session tags returning usable credentials | The AgentCore runtime, identity vault and registry; ECS and MicroVM task lifecycles |
| CloudWatch Logs: stream creation and writes | Anything that depends on eventual consistency, `TransactionConflict` or TTL timing |

The two columns are separate lists; rows do not pair.

The agent suite does contain five tests that expect a denial: three cross-tenant calls refused under the session role's policy, and two roles that cannot be assumed. They are a tripwire for the agent's wiring (the session tags reach STS, and tenant data goes through the scoped session). AWS says the emulator does not evaluate policies the way IAM does, so a pass is not evidence that the deployed policy is safe, and these are the tests most likely to change with an emulator release.

Twelve operations ABCA calls do not work and stay on mocks. Eight answer 501: `InvokeAgentRuntime`, `StopRuntimeSession`, `RetrieveMemoryRecords`, `GetResourceOauth2Token`, `CompleteResourceTokenAuth`, `UpdateRegistry`, `UpdateRegistryRecordStatus`, and `RespondToAuthChallenge` for `NEW_PASSWORD_REQUIRED`. Four agent-registry operations answer with timestamps the JavaScript SDK refuses: three reads, and `SubmitRegistryRecordForApproval`, which takes effect on the server and then fails in the client. ABCA catches the error from three of the eight and continues, so a test of those paths is green while exercising only the fallback. `ApplyGuardrail` needs a test-side HTTP/1.1 request handler, because the bedrock-runtime client negotiates HTTP/2 and the emulator offers only HTTP/1.1.

### Known differences from AWS

| Difference | Consequence |
|---|---|
| With TTL enabled, an expired item is deleted 0.5 to 1.0 seconds after expiry; AWS says typically within a few days | Code that relies on TTL deletion instead of comparing `ttl` with the clock looks correct. The `cdk` harness therefore leaves TTL off |
| Index reads always reflect the preceding write, and a transaction is never cancelled with `TransactionConflict` | A read-after-write through a GSI can never miss here, and the retry for a conflicting transaction cannot be reached |
| Throttling and partial batches occur only at the limits the emulator models, which are AWS's documented ones: a provisioned table past its units, one partition key written past 1,000 write units in a second (three puts of about 390 KB), a `BatchGetItem` past 16 MB | ABCA's on-demand tables with ordinary rows do not reach them (300 small writes to one key, none refused). A test with large rows on one key can be throttled, and those branches can be exercised on purpose |
| About a dozen malformed expression forms are accepted, and a condition comparing an attribute with itself lets the write through | A typo of that kind passes here and is refused by AWS |
| Presigned POST: the policy and the signature are not enforced the way S3 enforces them | A test that the bucket refuses an upload outside the policy cannot be written here |
| A stream emits a `MODIFY` record for a write that changes nothing | Never assert on record or invocation counts |
| A force-deleted secret keeps its name blocked for about 0.5 seconds | Remove-then-recreate in one test needs a retry |
| `ListSecrets` returns more than 100 results in one page; ECS `RunTask` accepts overrides over 8,192 characters | Two historical ABCA defects would have passed |

### Rules for tests in this tier

1. Rows come from the real writer and schemas from the CDK constructs.
2. Assert on stored state and on error names. Never assert on AWS message text, stream record counts or invocation counts.
3. Never wait for TTL expiry. To test expiry logic, write a row with a past `ttl` and assert what the handler decides.
4. Age the data, not the clock: the emulator rejects requests signed more than 15 minutes from its own time, so fake timers break signing.
5. One set of uniquely named tables per test file (jest) or per session (pytest), created together; a fresh user or task id per test.
6. When code swallows an error from an operation the emulator does not implement, assert which branch ran.
7. Every expected failure or emulator-specific branch names the upstream record it waits for.
8. Nothing but the emulator and loopback. Stub every endpoint that is not an AWS SDK call, and never follow a URL the emulator returns. The tooling enforces this for the Node processes the wrapper starts and for the pytest process.

## Proposed integration

### How it runs

```
mise run test:integration
  emulator.sh up     build the pinned image if missing, start a fresh emulator on 127.0.0.1
  emulator.sh run    jest  (cdk/jest.emulator.config.js)   real handlers in process
  emulator.sh run    jest  (cli/jest.emulator.config.js)   real CLI code in process
  emulator.sh run    pytest tests_emulator                 real agent code in process
  emulator.sh down   stop it; all state is discarded
```

The mise tasks are root tasks: run them from the repository root.

Handlers are not run inside the emulator's Lambda. That runtime is QuickJS with generated stand-ins for the AWS SDK, not Node, so a handler that passes there has not been tested against the real SDK, and most of ABCA's do not run there at all (see [Deploying to the emulator](#deploying-to-the-emulator)).

### Files

| File | Purpose | Lines |
|---|---|---|
| `scripts/aws-emulator/Dockerfile` | Pinned emulator version, base image pinned by digest, package verified against the AWS publishing key by fingerprint, telemetry off | 62 |
| `scripts/aws-emulator/emulator.sh` | `up`, `down`, and `run <command>` with the AWS environment replaced | 133 |
| `scripts/aws-emulator/jest-config.js` | Builds a package's emulator jest configuration from its unit configuration; refuses unless the AWS environment is the wrapper's | 45 |
| `scripts/aws-emulator/jest-global-setup.js` | Before any test file loads, confirms that the loopback guard is in force and that the endpoint is the emulator | 54 |
| `scripts/aws-emulator/loopback-only.cjs` | Node preload that refuses any TCP connection leaving the machine | 47 |
| `cdk/jest.emulator.config.js`, `cli/jest.emulator.config.js` | Two lines each | 4 |
| `mise.toml` | Tasks `test:integration`, `emulator:up`, `emulator:down`, `emulator:run`; none is reachable from `mise run build` | +38 |
| `agent/pyproject.toml` | Ruff exceptions for `tests_emulator/**`: the list PR #1035 gives `tests/**`, which also passes on `main` | +1 |
| `.dockerignore` | The tooling directory stays out of the agent image context, so a version bump does not change the image hash | +4 |

The tier itself changes no other tracked file. The unit runs cannot pick the emulator tests up, by naming and location and not by ignore lists: the jest files are `*.emulator.ts`, which the unit `testMatch` does not match, and the agent suite is in `agent/tests_emulator`, beside `tests/`, which is the only directory the unit run collects.

The emulator's per-run credentials and certificate are written under the user cache directory, outside the repository, because the agent image asset fingerprints the repository root.

### Keeping the tier away from real AWS

The same tests with no endpoint set would call AWS with whatever credentials the shell holds, and product code also makes calls that are not AWS SDK calls at all. The guard is layered:

1. **The wrapper replaces the AWS environment.** `emulator.sh run` removes every `AWS_*` variable, not a list of known ones, then sets the endpoint, the emulator's credentials file and its certificate. A leftover `AWS_ENDPOINT_URL_<SERVICE>` or `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` would otherwise route calls to real endpoints. It also removes `GITHUB_TOKEN`, `GH_TOKEN` and `BGAGENT_API_KEY`, points `BGAGENT_CONFIG_DIR` away from `~/.bgagent`, and refuses to run anything unless the emulator answers its health route. Everything else in the caller's environment is inherited, other tokens included. One exception to the removal: a mise shim re-applies a mise `[env]` after the wrapper has run, and inside `mise run`, `yarn` can be a shim. `AWS_*` variables that come back are refused by layer 2. The three tokens are not checked again, so a token kept in a mise `[env]` is present in the jest processes, where layer 4 keeps it on the machine.
2. **The test configurations refuse a foreign environment.** The jest configurations and the pytest session require `AWS_ENDPOINT_URL` to be `https://127.0.0.1:<port>` and no `AWS_*` variable other than the ones the wrapper sets. There is no skip path, so a run cannot be green having tested nothing.
3. **The endpoint is confirmed before any test.** The jest global setup requires the emulator's health route to answer over the certificate of this run. The pytest session requires STS, with a client built the way agent code builds one, to answer as account `000000000000`; a setting in the shared config file that turns `AWS_ENDPOINT_URL` off shows up there. The jest check confirms the address in the variable, not where SDK clients resolve. Such a setting cannot occur through the wrapper, which replaces the config file, and layer 4 covers it otherwise.
4. **Nothing may connect anywhere but loopback.** The environment only says where AWS SDK calls go. Product code also calls GitHub, Slack, Linear and Jira; the API-key authorizer's token verifier fetches its key set from the real `cognito-idp` host; `shared/agentcore-browser.ts` opens a hand-signed WebSocket. The wrapper preloads a module into every Node process it starts (jest and its workers, `tsx`, the CLI) that refuses a non-loopback TCP connection; child Node processes get it through the inherited `NODE_OPTIONS`. The agent suite installs the same rule as a Python audit hook in the pytest process, where it also covers datagrams and the lookup of a name. Both check themselves on every run: before any test, the jest global setup and the pytest session try to reach a `.invalid` host and stop the run unless that is refused, so jest does not start without the preload. Nothing else is covered: a Python subprocess, a Node process started with an environment that drops `NODE_OPTIONS`, UDP from Node, programs that are neither (`git`, `gh`, `uv`), a name that Node code resolves itself (`node:dns`), and a reverse lookup of an address in Python. No emulator test starts or reaches one of those. A refused connection reaches the caller as an ordinary network error, so a test of code that swallows network errors has to assert that no request was attempted.
5. **Only emulator-issued keys exist in that environment.** AWS does not recognize them. This is the one layer that could not be tested without calling AWS.

For boto3 the certificate bundle is a further guard: it replaces the trust store, so a call that did go to an AWS host fails at the TLS handshake. (Node only adds the emulator's certificate to its own, which is why layer 4 exists.) It was needed once during the investigation. AWS CLI v1 forces a real endpoint for `sqs`, `rds`, `docdb`, `neptune` and `health` whatever `AWS_ENDPOINT_URL` says, and one `aws sqs` command dialed `queue.amazonaws.com`; the handshake failed before any request was sent. The tier uses SDKs only, and `emulator:run` is not for that CLI.

What reviewers tried and could not break. Before the loopback guards existed, with every Node and Python process recording connections, the three suites made 181 connections, all to `127.0.0.1`; a shell polluted with 23 fake `AWS_*` variables left only the wrapper's; a home directory with canary `~/.aws` and `~/.bgagent` files was neither used nor modified; the emulator container opened no outbound connection. With the guards in place, a recorder under the Node preload saw 60 connection attempts in 8 Node processes during a whole run: 52 to `127.0.0.1`, 8 to local pipes, none refused. Each refusal described above was then tried on purpose, by a reviewer or in the final check, and behaved as written; the two self-checks were tried with the preload removed and with a copy of the agent suite whose hook was not installed.

What is outside the guard:

- `emulator:up` runs the container engine with the caller's environment. If Docker is configured to use the ECR credential helper for `public.ecr.aws`, an image build would ask ECR Public for a token with real credentials when it pulls the base image (a read-only call; reasoned from the tooling, not observed).
- The port is published on the host's loopback interface only, but other containers on the same Docker engine can reach it. They still need the per-run key, except for the routes the emulator serves unsigned.
- After a failed `test:integration` the emulator stays up for inspection, with its per-run credentials on disk (mode 0600), until `emulator:down`, the next `emulator:up`, or, per the emulator's CLI reference, an hour without an API call (not tested).

### Fit with pull request #1035

PR #1035 isolates the unit suites: the CLI's jest `globalSetup` deletes every `AWS_*` variable and a setup file restricts sockets to loopback, and the agent's `conftest.py` deletes them, refuses every botocore request and fails CI when any test is skipped. Its `pyproject.toml` makes pytest warnings errors and adds ruff rules, its coverage contract pins the jest blocks of `cdk` and `cli`, and its dead-code check is zero-tolerance over `test/` and `scripts/`. An emulator test that sits inside those harnesses and skips itself when no emulator is present cannot work once that merges, which is why the tier is separate by naming and location.

Checked by taking #1035's files from git (head `9525c2d8`), not by merging:

| #1035 gate | Result on this worktree |
|---|---|
| Coverage contract over the jest blocks | No drift: neither `package.json` is edited |
| ESLint with its `cdk` and `cli` configurations, `--max-warnings 0` | Clean |
| Ruff 0.17.3 with its `agent/pyproject.toml`, which adds the `ARG` rules and a `TID251` banned-API table | Clean. The `tests_emulator/**` line carries the exception list #1035 gives `tests/**`; with the list `main` uses for `tests/**` there are 17 findings |
| `cli` emulator suite under a #1035-style unit configuration | 5 passed. The emulator configuration replaces the unit `globalSetup` and inherits the loopback-only setup file |
| Agent emulator suite with `strict = true` and warnings as errors | 42 passed, three runs. The unit conftest never applies to `tests_emulator` |
| Dead-code check with its `knip.json` | Eight of the new files are reported as unused until seven entry lines are added, after which nothing is: `jest.emulator.config.js` and `test/emulator/*.emulator.ts` in the `cdk` and `cli` workspaces, `test/emulator/trace-api-shim.ts` in `cdk`, and `scripts/aws-emulator/jest-global-setup.js` and `loopback-only.cjs` in the root workspace |

If #1035 merges first, each slice of the rollout carries its own `knip.json` entries (four, one and two lines). `agent/pyproject.toml` is the one file where the two change sets conflict textually (adjacent lines); `mise.toml` and `.dockerignore` merge cleanly.

### CI

A separate workflow, not a job in `build.yml`: `deploy.yml` and `integ.yml` start from `workflow_run` on `build` and need its conclusion to be `success`, so an advisory failure there would stop both. The workflow in [Appendix A](#appendix-a-workflow) uses no secret and `contents: read` only, so it runs unchanged for fork pull requests. It adds no finding to the repository's own `zizmor` gate and passes `actionlint`.

It has not run on GitHub, and the three suites have run on macOS only. On Linux, an earlier version of the wrapper was exercised as an unprivileged user against a Linux Docker daemon on arm64 (`up` with the image copied in, a signed STS call through `run`, `down`), and the `linux/amd64` image was built and started under emulation on a Mac. Still to run on Linux: the image build through `emulator.sh up`, the wrapper as it is now, and jest and pytest under the loopback guards. The first run on a GitHub-hosted runner covers all of these.

The parts measured so far add up to 2.1 to 2.3 minutes: 83 to 89 seconds of overhead for a comparable job (`dead-code-pr`, checkout through `mise run install`), a 16 to 24 second image build and the 24 second tier, the last two on a laptop. The estimate of 2.5 to 3.5 minutes allows for a slower hosted runner.

Advisory here means visible and not required: the job is left out of the ruleset's required checks and a failure shows as a red check. The repository's one existing advisory gate, `dead-code-pr.yml`, masks failures with `continue-on-error` instead; a red check keeps the history measurable for the graduation criteria below. That a red check which is not required does not hold up the merge queue is taken from GitHub's documentation, not observed.

### Version pin

One pin, the `ARG AWS_EMULATOR_VERSION` line in the Dockerfile. To move it, run `ABCA_EMULATOR_VERSION=<new> mise run test:integration` and then edit the line. The image tag carries the version and a checksum of the Dockerfile, so either change is rebuilt. The override was run once, with v1.0.367, before the tag carried the checksum. The wrapper does not remove old images; after a bump, delete the previous tag (`docker image rm abca-aws-emulator:<old tag>`, about 1 GB each). Upstream ships several releases a day and puts security fixes only in the newest one, but the exposure is small by construction: published on host loopback only, no real credentials or data, a CI job with no secret.

Pinning is not optional. The user guide says passing fidelity tests do not regress; the published scores say otherwise. On an unchanged test set (v1.0.336 to v1.0.385, 2.2 days), up to 23 tests on the six core services went from pass to fail because of the emulator. None is a happy-path test of an operation ABCA calls on DynamoDB, S3 objects or Secrets Manager. The one that matters to ABCA is Cognito: v1.0.382 changed the token `iss` claim, and running this tier on v1.0.367 fails exactly one test, on that claim. ABCA's own suite on the candidate version is the gate for a bump; the release notes are the second check.

### Relation to what exists

| Existing piece | Proposal |
|---|---|
| DynamoDB Local suites in open PRs #1009, #1013, #904 | Leave them on DynamoDB Local. #904 adds it as a service container in the required `build` job, which is where these suites would run, and it is the more mature DynamoDB engine. Porting them to the emulator has not been tried. It would need the files moved to `test/emulator/*.emulator.ts`, their `http://127.0.0.1` guard and own endpoint variable replaced by the wrapper's environment, and their injected dummy credentials removed; it would move them out of the required build into the advisory workflow; and the `TransactionConflict` retry in #1009 cannot be exercised on the emulator. The emulator does a different job: it is the only option that also covers S3, Secrets Manager, Cognito, STS and Logs behind one endpoint |
| `agent/run.sh --local-events` with DynamoDB Local | Keep. That flow uses real credentials for Bedrock and redirects only DynamoDB; the emulator rejects keys it did not issue |
| Hand-written DynamoDB fakes | Replace later, after measuring what they contribute to the coverage thresholds |
| Issue #61 | `agent/tests_emulator/test_trace_round_trip.py` meets its end-to-end and under-10-seconds criteria. Its opt-in marker criterion is met differently (a separate directory and run, not a marker) and its README criterion is not met |
| ADR-013 | Replace the LocalStack wording with the emulator; replace the "60%+" sentence with the measured statement in [What it is worth](#what-it-is-worth); add the graduation criteria below; state that Tier 2c (the ephemeral stack deploy, which the ADR expects to catch IAM gaps) stays on real AWS |
| Real-AWS integ smoke | Keep as the authority for IAM, deployment and API Gateway wiring, and unblock it; the emulator tier does not stand in for it |

## Deploying to the emulator

Not recommended as a tier now. The boundary was measured and is narrower than a green deployment suggests.

What works: the existing integ app (`cdk/test/integ/integ.task-api-smoke.ts`) deploys unmodified with `cdk bootstrap` and `cdk deploy`, 53 resources of 18 types, in about 52 seconds for a full cycle including synth and destroy. All 53 were read back from their owning services with the declared properties. Requests through the deployed REST API pass the Cognito authorizer and reach the handlers, provided the client sends a non-loopback `Host` header and a `User-Agent`, because the emulator evaluates the stack's WAF managed rules. Emulated CloudFormation also rejects template mistakes that type checking and template assertions accept, such as a GSI key missing from the attribute definitions.

What does not:

- **integ-runner's assertions cannot complete.** They are Lambda-backed custom resources with Node providers, and the emulated Node runtime has no HTTP client to answer CloudFormation with. A Python provider does complete.
- **Handlers mostly do not run there.** Through the deployed API the six Task API routes answer 200, 200, 500, 502, 502 and 502. A package file over 8 MiB is truncated, sometimes without any error.
- **A stack status is not proof.** Four resource types, including the AgentCore runtime and memory, reach `CREATE_COMPLETE` and create nothing.
- **The full platform is refused.** The minimal profile has 318 resources. Six of its resource types are unknown to the emulator, and the template is refused until the resources of those types are removed. With those and the six custom resources removed and three resources patched, 302 reach `CREATE_COMPLETE`. Leaving out the three patched ones and four that create nothing, 295 of the 318 deploy unmodified and exist (an investigator's measurement that no verifier re-ran).
- **Bootstrap policy gaps stay invisible.** A missing `Allow` never fails a deployment; only an explicit `Deny` or a broken trust policy does, and ABCA's execution policies contain no `Deny`.

Of the 120 historical defects, two would have been caught by a deployment to the emulator. Revisit when the emulated Lambda runtime is real Node (`aws/aws-emulator#28` and `#325`).

## Rollout

The proposal at hand-over was three pull requests, one per suite, each with its own issue. The owner chose one branch and one pull request instead, with the workflow and the fixes in it (see [Outcome](#outcome)). That pull request touches paths the admin team owns in CODEOWNERS (`mise.toml`, `.github`, the `AGENTS.md` files).

Left for later from the three-slice plan:

- Take the agent suite's table schemas and its session-role policy from the synthesized template instead of copying them by hand, and derive the CLI's fixture stacks from the constructs.
- Declare `tsx` in `cli`. The trace round trip runs CLI source with it and only `@abca/cdk` declares it; a new dependency there needs agreement first.
- Tests of the `bgagent setup` AWS adapters, which no test executes today. The last of the five (`setBootstrapComputeTypes`) can only be reached by exporting `defaultDeps` from `cli/src/commands/setup.ts`, a small product-code change.

First tests to add, by expected value:

1. The approval lifecycle across the agent, the handlers and both reconcilers, with the agent's real transition writing the rows. It covers the three approval defects found here.
2. Every handler that combines `Limit` with a filter or reads one page, seeded with more than a page of non-matching rows first (#51 and its four relatives).
3. Approve and deny as real transactions, replacing `approval-concurrency.test.ts`, whose mock scripts the outcome it asserts.
4. One invariant over all writers of a task's `status`: `status_created_at` follows the status, and a terminal row has `completed_at` and `ttl`.
5. The attachment upload path, asserting the handlers' decisions and not S3's enforcement.

Graduation to a required check, measured over 30 days: every red run triaged; none of the last 100 pull-request and merge-queue runs red because of the emulator or the runner; p95 job duration under 5 minutes; at least one test per service in scope; the pin never more than 14 days behind. Then add the job name to the ruleset, and have CI install the pinned `.deb` on the runner from a cache instead of building the image, so that a required check does not depend on two download hosts (`public.ecr.aws` for the base image, `downloads.aws.com` for the package) on every run.

## Costs and risks

- **A young dependency.** 417 open issues days after its first release, behavior changing daily. The pin contains it; the list of differences has to be kept.
- **False confidence.** Emulator-green is not AWS-green. The table of differences above is the minimum that contributors need to know, and it will grow.
- **Docker.** The wrapper runs the emulator in a container on every platform, CI included; the native Linux package is not used. Docker is already needed for CDK asset bundling.
- **License.** The source repository is CC0-1.0 with Apache-2.0 vendored code. The package's own `THIRD_PARTY_LICENSES` file lists four crates under LGPL-3.0-only among 961. ABCA downloads the package from AWS at use time and never redistributes it. Committing the package, publishing a prebuilt image, or baking it into an image ABCA distributes would change that and needs a license review first.
- **Telemetry.** On by default upstream; the image turns it off in two places.
- **Invisible to scanners.** The package is one statically linked binary with no audit metadata; `grype` catalogs zero packages in it. Its vulnerability management is the bump cadence.
- **Not verified.** The workflow has not run on GitHub, so its duration, its behavior for fork pull requests and the assumption about the merge queue are untested. The suites have run on macOS only. The worktree has not been merged with #1035; that pull request's gates were simulated one by one. The DynamoDB Local suites of #1009, #1013 and #904 have not been run on the emulator. The full-platform deployment figures were not re-run. Nothing in this investigation was compared with real AWS: every statement about AWS behavior is from AWS documentation, the published fidelity suite, or ABCA's own commit history.

## Not built, and when to add it

| Left out | Add it when |
|---|---|
| A scheduled run that tries the newest upstream release | Manual bumps become a chore, or the tier is headed for required status |
| One table set shared by all jest test files (the agent suite already shares one per session) | The 3 second wait per file starts to dominate the run |
| Reading each handler's environment from its construct | A variable-name drift reaches a deployed stack |
| A stream driver (read real stream records, apply the construct's filter, call the consumer) | The first test of the orchestration reconciler or fan-out is written |
| Request timeouts on the harness clients | A stalled emulator is seen in practice. Today the health probe before the run and the job timeout bound it |
| A check that the downloaded package is the pinned release, beyond who signed it | The download host is not trusted to serve the file its URL names |
| A deploy-to-emulator check | The emulated Lambda runtime is real Node |
| Letting ABCA's own agents run the tier inside their container before they open a pull request (the self-validation ADR-013 is written for) | The check is required, so that an agent's pull request is not judged by a check the agent could not run. Today the agent image has no Docker, AgentCore caps images at 2 GB, and the egress allowlist lacks `downloads.aws.com`. The agent suite would also have to clear the agent variables it inherits |

## Defects found during the investigation

Code references are to `main` at `c8fcdb08`. Unless a row says otherwise, the defect was found by one investigator and confirmed by an independent verifier: the product defects by running the real code against the emulator, the two CI rows from the GitHub API. One row has a single execution behind it: the heartbeat defect was found and run in real time by a verifier (a later reviewer read the code path and found it consistent). The concurrency-group mechanism was established by a verifier and confirmed live by a later reviewer.

| Defect | Where | What was observed | Tracking |
|---|---|---|---|
| The stranded-approval sweep measures from the start of `RUNNING`, not from the approval request | `agent/src/task_state.py:706-708,762-764`; `cdk/src/handlers/reconcile-stranded-tasks.ts:108-142` | With the agent's real hook and the real reconciler, a task that had been `RUNNING` for 2 h 5 min was failed "Approval stranded" 0.3 s after it opened its gate. The user's approval was refused with 409, the gated call was denied when the agent's own wait ended, and the agent went on to open a pull request for a task reported `FAILED`. Tasks are exposed when they open a gate after about 1 h 55 min of running | None. Open PR #1013 adds a TypeScript writer with the same omission |
| A task resumed after an approval wait longer than 240 s can be failed as "Agent session lost" | `agent/src/task_state.py:106-127,762-764`; `cdk/src/handlers/shared/orchestrator.ts:1113-1137` | Heartbeats are not written while a task awaits approval and the resume does not refresh one. With both timers on their own cadence, a 275 s wait ended `FAILED` 25 s after the user approved; a 205 s wait survived. AgentCore and Lambda MicroVM backends | None. Fixed in passing inside open PR #904 |
| The concurrency reconciler counts four statuses where `ACTIVE_STATUSES` lists five | `cdk/src/handlers/reconcile-concurrency.ts:40-48` against `cdk/src/constructs/task-status.ts:95-101` | Reproduced with the real handler and the agent's real transition. One verifier also saw the same handler count a `SUBMITTED` task that holds no seat | None. Open PR #1009 rewrites the handler on `ACTIVE_STATUSES` and tests it |
| A never-configured GitHub token secret is reported as configured | `cli/src/github-token.ts:115-118`; `cdk/src/stacks/agent.ts:305-308` | CDK seeds the secret with a random 32-character string; the CLI assumes a JSON placeholder. On a fresh stack `platform doctor` passes the token check and the first `github set-token` warns about overwriting a token. `github set-webhook-secret` uses the same test (read, not run) | None. Same root cause as closed #368, fixed there for the Jira webhook secret only |
| A session role that cannot be assumed does not abort the task, although three comments say it does | `agent/src/aws_session.py:35-41,186-192`; `agent/src/pipeline.py:906-909`; `agent/src/server.py:974-975` | `AssumeRole` is deferred by design. The agent completed the clone, agent loop and pull-request steps with nothing written to the task or events tables; gated tool calls were denied. On AgentCore and MicroVM the orchestrator reports "Agent session lost" about six minutes later. A task with attachments does abort, at the download. No tenant data was read or written with the unscoped credentials. In a CDK-managed deployment this probably needs drift or an SCP (inferred) | None |
| The trajectory writer never retries stream creation | `agent/src/telemetry.py:157-174` | A first `CreateLogStream` that fails after the SDK's retries loses the task's whole CloudWatch trajectory | None |
| #51: list order and the empty filtered page | `cdk/src/handlers/list-tasks.ts:83-110` | Reproduced with the unmodified handler. Fixing it with a key condition on `status_created_at` would hide approval-paused tasks under `AWAITING_APPROVAL` (shown by a direct index query) and Slack-cancelled tasks under `CANCELLED` (inferred from the stored row), because neither writer maintains that attribute; design the two together | #51 |
| #1003: a replayed finalize step releases a second seat | `cdk/src/handlers/shared/orchestrator.ts:1235-1297` | Reproduced | #1003, PR #1009 |
| `integ.yml` is blocked by its own concurrency group; `integ-smoke` is not a required check | `.github/workflows/integ.yml:45-47,198` | See [Against the CI record](#against-the-ci-record) | Open PR #1035 moves the group to the deploy job (its commit `6eb6662f`). Open #400 proposes relaxing the same group for another reason |
| `upgrade-main` has failed on every scheduled run since 2026-08-19 | The repository secret `AUTOMATION_GITHUB_TOKEN`, which `.github/workflows/upgrade-main.yml` uses | 89 consecutive failures in the Create Pull Request job: GitHub refuses the fetch and the push made with that token. The workflow file is the one that succeeded the day before, and the secret has not been updated since 2026-06-11. The last pull request the job opened is #590 on 2026-07-11 | None |

Smaller observations: the Slack cancel button writes less than `cancel-task` (a stale `status_created_at` and no `completed_at`); cancelling a running task through the API records `task_cancelled` twice; `bgagent ops stuck-tasks` ages tasks by creation time, so an approval-paused task created long ago is listed as stuck; the agent stores `cost_usd`, `duration_s` and turn counters as DynamoDB strings while `numeric.ts` blames the SDK and `TaskRecord` declares numbers (every current reader coerces); the agent unit suite depends on test order through `hooks._LAST_BLOCKER_REASON`.

Also confirmed, and already fixed with a regression test in open PR #1035: eleven Lambda bundles contain all of `aws-cdk-lib`.

## Open decisions

Decided on 2026-11-15 (see [Outcome](#outcome)): 1 (yes), 2 (a red check that is not required), 8 (the tables in Outcome) and 9 (one branch and one pull request, with its issue). The others are open; for 4, 5 and 6 the pull request follows what this document proposes.

1. Adopt the tier as advisory, in the shape above?
2. Advisory as a red check that is not required (proposed), or masked with `continue-on-error` as `dead-code-pr.yml` does?
3. One local backend or two? #904 adds DynamoDB Local as a service container in the required `build` job, where the suites of #1009, #1013 and #904 would run. Proposed: keep them there and use the emulator for what DynamoDB Local cannot reach. Porting them (not tried) gives one backend, but moves them into the advisory workflow and gives up the `TransactionConflict` retry.
4. Do known-defect witnesses (`test.failing`) ship, or only passing tests? A `test.failing` passes on any throw, so each has to be run once as a plain test; the alternative is a test that asserts today's wrong value and fails when it is fixed. The repository already ships one such witness (`cdk/test/integration/orchestration-e2e.test.ts:402-412`).
5. Keep the five agent tests that expect an emulator-evaluated denial, knowing they can break with an emulator release?
6. Directory names: `test/emulator` and `tests_emulator` (what the tests need) or `integration` (what ADR-013 and issue #61 call the tier). `cdk/test/integration` already holds fake-backed tests that run in the unit tier.
7. `integ.yml`: unblock it (open #400 proposes relaxing the same concurrency group), and should `integ-smoke` be a required check? `integ.yml` and ADR-013 call it required; the ruleset does not list it.
8. Which of the defects marked "None" to file, and in what order. The #51 fix and the status writers are one design, and the approval-sweep fix has to land in whichever writer is current when #1013 merges.
9. The issues the tier needs before any branch (ADR-003): one per slice. #61 is open and not labeled `approved`.
10. Which upstream reports to file (Appendix B).

## Appendix A: workflow

`.github/workflows/emulator.yml`. The committed file is this block, byte for byte.

```yaml
name: emulator
# ADR-013 Tier 2a: runs ABCA's real handler, CLI and agent code against the AWS Emulator
# (https://github.com/aws/aws-emulator) instead of module-level SDK mocks. No AWS account,
# role or secret is involved, so it runs unchanged for fork pull requests.
#
# Advisory: the job is not in the required status checks of the `main` ruleset, so a red run
# is visible on the pull request but does not block the merge. To make it required, add the
# job name ("Emulator integration tests") to the ruleset; it already runs on merge_group,
# which a required check must do or the merge queue deadlocks (#327).
#
# Kept out of build.yml on purpose: deploy.yml and integ.yml start from `workflow_run` on
# build and need its conclusion to be `success`.
on:
  pull_request: {}
  merge_group: {}
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: emulator-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  emulator:
    name: Emulator integration tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    env:
      CI: "true"
      MISE_EXPERIMENTAL: "1"
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Install mise
        uses: jdx/mise-action@b44d12e7d0d8ee7461bb893e1b1993500433185b # v5.2.7
        with:
          version: 2026.10.25 # exact mise release for every workflow (#890); bump by PR
          cache: true

      - name: Setup Node.js
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22.x

      - name: Install dependencies
        run: mise run install

      # Builds the pinned, signature-verified emulator image, starts a fresh emulator on
      # loopback, runs the cdk, cli and agent emulator suites, and stops it.
      - name: Emulator integration tests
        run: mise run test:integration

      - name: Emulator log (on failure)
        if: failure()
        run: |
          docker ps -a --filter name=abca-aws-emulator --format '{{.Names}}' \
            | xargs -r -n1 docker logs --tail 200 || true
```

The emulator logs its start-up and table creation only, so the last step shows whether the emulator started, not why a test failed.

## Appendix B: upstream reports worth filing

Nothing was filed. None of the five is in the emulator's in-repository issue log at the commit examined (the last three by keyword search only), and searches of its GitHub tracker on 2026-11-15 found no report of them.

| Report | Evidence |
|---|---|
| The `lib-dynamodb` stand-in inside emulated Lambda throws on `ExclusiveStartKey: undefined`; the real SDK skips undefined values | The same query from host Node with the real SDK succeeds against the same table |
| A Lambda package file over 8 MiB is truncated, and runs without error when the cut falls on a statement boundary | A file 35 bytes over the cap returned the handler defined before the cut |
| `ListSecrets` returns more than 100 results without `MaxResults` | 103 secrets came back in one page |
| ECS `RunTask` accepts container overrides longer than 8,192 characters | A 12,000-character override was accepted |
| Four agent-registry operations (`GetRegistry`, `GetRegistryRecord`, `ListRegistryRecords`, `SubmitRegistryRecordForApproval`) return `createdAt` and `updatedAt` as epoch numbers, which the AWS SDK for JavaScript refuses | boto3 accepts the same responses; the JavaScript client throws on each |

Already recorded upstream and worth a comment, not a duplicate: `RespondToAuthChallenge` for `NEW_PASSWORD_REQUIRED`, Node custom-resource providers, AgentCore resources that are declared but not created, a write condition that compares an attribute with itself being accepted, `CreateOauth2CredentialProvider` answering a duplicate name with `ConflictException` where ABCA's history records `ValidationException` from AWS, the `gpg --import` step of the user guide that fails in the guide's own base image (`aws/aws-emulator#313`), the four-part version in `versions.json` that package URLs reject (`#434`), the fixed 3 second table transition (`#436`), and the missing HTTP/2 listener (`#31`).

## Appendix C: running the proof of concept

From the repository root:

```bash
mise run test:integration                  # everything, on a fresh emulator
mise run emulator:up                       # or keep one running while iterating
mise run emulator:run -- yarn --cwd cdk jest --config jest.emulator.config.js task-api
(cd agent && ../scripts/aws-emulator/emulator.sh run uv run pytest --no-cov tests_emulator/test_secrets.py)
mise run emulator:down
```

The first `emulator:up` builds the image (about 16 seconds, a 161 MB download on arm64 and 182 MB on x86_64). Two worktrees can run the tier at the same time; the port is derived from the checkout path.

A green run prints about 45 INFO lines from the handlers during the `cdk` step, among them "Drift detected" from the concurrency reconciler. They are the product's own logs, not failures. Tests marked `test.failing` are counted and listed as passed.
