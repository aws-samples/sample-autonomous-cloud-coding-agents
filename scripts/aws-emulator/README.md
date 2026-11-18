# Emulator-backed integration tests

This tier (ADR-013 Tier 2a) runs ABCA's real handler, CLI and agent code in the normal test runners, jest and pytest, with no SDK mock: the AWS SDK calls go to an [AWS Emulator](https://github.com/aws/aws-emulator) on loopback. It needs Docker and `curl`, and no AWS account.

It is an advisory check: the [`emulator` workflow](../../.github/workflows/emulator.yml) runs it on every pull request and is not a required check. [ADR-013](../../docs/decisions/ADR-013-tiered-validation-pyramid.md) has the criteria for making it one. It does not replace the real-AWS integ smoke (`mise //cdk:integ`), which stays the authority for IAM, deployment and API Gateway wiring. The investigation behind the tier, with what was measured and what was not verified, is in [docs/research/aws-emulator-local-tests.md](../../docs/research/aws-emulator-local-tests.md).

## Run it

From the repository root, after `mise run install` (the mise tasks are root tasks):

```bash
mise run test:integration   # everything, on a fresh emulator: about half a minute
mise run emulator:up        # or keep one running while iterating
mise run emulator:run -- yarn --cwd cdk jest --config jest.emulator.config.js task-api
(cd agent && ../scripts/aws-emulator/emulator.sh run uv run pytest --no-cov tests_emulator/test_secrets.py)
mise run emulator:down
```

- The suites are `cdk/test/emulator/*.emulator.ts`, `cli/test/emulator/*.emulator.ts` and `agent/tests_emulator/`. The unit runs cannot pick them up: the unit `testMatch` does not match `*.emulator.ts`, and the agent's unit run collects `tests/` only.
- The first `emulator:up` builds the image (about 1 GB) from the [Dockerfile](Dockerfile), once per version: it downloads the signed package, about 170 to 190 MB, and verifies it.
- Emulated state is in memory and there is no reset call. `emulator:up` always starts a fresh emulator, and `emulator:down` discards everything.
- The port is derived from the checkout path, so two worktrees can run the tier at the same time. The header of [emulator.sh](emulator.sh), the wrapper behind these tasks, lists the variables that override the port, the state directory, the version and the container engine.
- After a failed `test:integration` the emulator stays up for inspection (`docker logs abca-aws-emulator-<port>`) until `emulator:down` or the next `emulator:up`. Its per-run credentials stay on disk (mode 0600) under the user cache directory, and it is started with an idle timeout of one hour.
- The `cdk` step prints the handlers' own INFO logs, among them "Drift detected" from the concurrency reconciler. They are not failures. A `test.failing` case is reported as passed for as long as the defect or emulator gap it records exists.

## Rules for tests in this tier

1. Rows come from the real writer and schemas from the CDK constructs.
2. Assert on stored state and on error names. Never assert on AWS message text, stream record counts or invocation counts.
3. Never wait for TTL expiry. To test expiry logic, write a row with a past `ttl` and assert what the handler decides.
4. Age the data, not the clock: the emulator rejects requests signed more than 15 minutes from its own time, so fake timers break signing.
5. One set of uniquely named tables per test file (jest) or per session (pytest), created together; a fresh user or task id per test. A new table is unusable for 3 seconds, and tables created together share that wait.
6. When code swallows an error from an operation the emulator does not implement, assert which branch ran.
7. Every expected failure or emulator-specific branch names the record it waits for: an ABCA issue or pull request for a product defect, the upstream record for an emulator gap.
8. Nothing but the emulator and loopback. Stub every endpoint that is not an AWS SDK call, and never follow a URL the emulator returns. The tooling enforces this for the Node processes the wrapper starts and for the pytest process.

Rule 1 is not met everywhere yet. The agent suite copies its table key schemas and its session-role policy by hand from the constructs, the two `cli` fixture stacks are written by hand to match the `TaskApi` construct and the stack's GitHub token secret, and some rows are seeded by the tests. Nothing fails there when a construct changes.

## Where a green run can be trusted

A green run says how the code behaves against the emulator, not against AWS. Nothing in the tier is compared with real AWS, and the emulator's behavior changes between releases.

| Trust a green run for | Do not use the tier for |
|---|---|
| DynamoDB: conditions, update expressions, transactions with per-item cancellation reasons, index keys and projections, `Limit` before filter, pagination including the 1 MB page, reserved words | Permissions of any kind. A missing grant is invisible; identity policies are evaluated in some paths and not others |
| S3 objects: put, get, head, delete, versions, presigned GET | Presigned POST policy enforcement (see the differences below) |
| Secrets Manager: version stages, delete then restore, the error names and the one message text ABCA matches | Deployment correctness of the platform stack |
| Cognito: admin user operations, password login, first-login password rotation, refresh, change password, token claims other than `iss` | The hosted UI, MFA |
| STS: `AssumeRole` with session tags returning usable credentials | The AgentCore runtime and identity vault; ECS and MicroVM task lifecycles |
| CloudWatch Logs: stream creation and writes | Anything that depends on eventual consistency, `TransactionConflict` or TTL timing |
| Agent Registry: the custom resource creating a registry, and deleting it with the records it holds | Publishing more than one version of a registry asset (see the differences below) |

The two columns are separate lists; rows do not pair.

The agent suite contains tests that expect a denial: cross-tenant calls refused under the session role's policy, and roles that cannot be assumed. They are a tripwire for the agent's wiring (the session tags reach STS, and tenant data goes through the scoped session). AWS says the emulator does not evaluate policies the way IAM does, so a pass is not evidence that the deployed policy is safe, and these are the tests most likely to change with an emulator release.

Some operations ABCA calls do not work on the emulator and stay on mocks:

- Answered with 501 `NotImplemented`: `InvokeAgentRuntime`, `StopRuntimeSession`, `RetrieveMemoryRecords`, `GetResourceOauth2Token`, `CompleteResourceTokenAuth` and `UpdateRegistry`. ABCA catches the error from `StopRuntimeSession`, `RetrieveMemoryRecords` and `GetResourceOauth2Token` and continues, so a test of those paths is green while exercising only the fallback (rule 6).
- `ApplyGuardrail` needs a test-side HTTP/1.1 request handler: the bedrock-runtime client negotiates HTTP/2 and the emulator offers only HTTP/1.1.

## Known differences from AWS

Recorded on emulator 1.0.481. Keep this table and the lists above current when the version pin moves or a test finds another difference.

| Difference | Consequence |
|---|---|
| With TTL enabled, an expired item is deleted 0.5 to 1.0 seconds after expiry; AWS says typically within a few days | Code that relies on TTL deletion instead of comparing `ttl` with the clock looks correct. The `cdk` harness therefore leaves TTL off |
| A `Query` on an index that `UpdateTable` is still creating is answered; AWS does not allow it until the index is `ACTIVE`. The emulator does report the index as `CREATING`, for about 3 seconds | Code that queries an index before it is `ACTIVE` passes here and fails on AWS. Code that asks for the index status first, as the task list does, can be tested |
| Index reads always reflect the preceding write, and a transaction is never cancelled with `TransactionConflict` | A read-after-write through a GSI can never miss here, and the retry for a conflicting transaction cannot be reached |
| Throttling and partial batches occur only at the limits the emulator models, which are AWS's documented ones: a provisioned table past its units, one partition key written past 1,000 write units in a second (three puts of about 390 KB), a `BatchGetItem` past 16 MB | ABCA's on-demand tables with ordinary rows do not reach them. A test with large rows on one key can be throttled, and those branches can be exercised on purpose |
| About ten malformed expression forms are accepted, and a condition comparing an attribute with itself lets the write through | A typo of that kind passes here and is refused by AWS |
| Presigned POST: the policy and the signature are not enforced the way S3 enforces them | A test that the bucket refuses an upload outside the policy cannot be written here |
| A bucket holds at most 1,000 objects, counting every version and delete marker; a write that adds one more is refused with `ValidationException` | A listing at the default page size never has a second page, so the second page of the upload cleanup loop cannot be reached here |
| A force-deleted secret keeps its name blocked for about 0.5 seconds | Remove-then-recreate in one test needs a retry |
| `ListSecrets` returns more than 100 results in one page; ECS `RunTask` accepts overrides over 8,192 characters | Two historical ABCA defects would have passed |
| The `iss` claim of a Cognito token names the emulator, `https://127.0.0.1:<port>/<pool id>` in the tier; AWS issues `https://cognito-idp.<region>.amazonaws.com/<pool id>` | A verifier that derives the issuer from the pool id, as the one in the API's authorizer does, refuses every token the emulator issues |
| A second Agent Registry record under a name the registry already holds is refused with `ConflictException`, whatever its `recordVersion`; the AWS [user guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html#registry-concept-record) says the combination of name and `recordVersion` must be unique, so that a name can be reused across versions | ABCA publishes every version of an asset under the same record name, so a second version of an asset cannot be published here. That, and resolving across versions, stay on mocks |

## Keeping the tier away from real AWS

The same tests with no endpoint set would call AWS with whatever credentials the shell holds, and product code also makes calls that are not AWS SDK calls. The guard is layered:

1. **The wrapper replaces the AWS environment.** `emulator.sh run` removes every `AWS_*` variable, then sets the endpoint, the emulator's credentials file and its certificate. It also removes `GITHUB_TOKEN`, `GH_TOKEN` and `BGAGENT_API_KEY`, points `BGAGENT_CONFIG_DIR` away from `~/.bgagent`, and refuses to run anything unless the emulator answers its health route. Everything else in the caller's environment is inherited.
2. **The test configurations refuse a foreign environment.** The jest configurations (`jest-config.js`) and the pytest session (`agent/tests_emulator/conftest.py`) require `AWS_ENDPOINT_URL` to be `https://127.0.0.1:<port>` and no `AWS_*` variable other than the ones the wrapper sets. There is no skip path, so a run cannot be green having tested nothing.
3. **The endpoint is confirmed before any test.** The jest global setup (`jest-global-setup.js`) requires the emulator's health route to answer over the certificate of this run. The pytest session requires STS, with a client built the way agent code builds one, to answer as account `000000000000`.
4. **Nothing may connect anywhere but loopback.** Product code also calls GitHub, Slack, Linear and Jira, and none of that follows `AWS_ENDPOINT_URL`. The wrapper preloads `loopback-only.cjs` into every Node process it starts, which refuses a TCP connection that leaves the machine. The agent suite installs the same rule as a Python audit hook, where it also covers datagrams and the lookup of a name. Both check themselves before any test runs.
5. **Only emulator-issued keys exist in that environment.** AWS does not recognize them.

Most refusals of layers 2 to 4 are tested without an emulator in the unit suites, so a guard that stops making them fails the required build: `cdk/test/scripts/aws-emulator-guard.test.ts` and `agent/tests/test_emulator_guard.py`. The header of each file lists the refusals it does not cover.

What a test author has to know:

- A refused connection reaches the caller as an ordinary network error, so a test of code that swallows network errors has to assert that no request was attempted. When a test fails on the loopback rule, stub the call that tried to connect. Do not add hosts to the list.
- `emulator:run` is for programs that use an AWS SDK. AWS CLI v1 forces a real endpoint for `sqs`, `rds`, `docdb`, `neptune` and `health` whatever `AWS_ENDPOINT_URL` says.

What is outside the guard:

- Layer 4 does not cover a Python subprocess, a Node process started with an environment that drops `NODE_OPTIONS`, UDP from Node, or programs that are neither (`git`, `gh`, `uv`). No emulator test starts one of those.
- Layer 4 refuses connections, not every DNS question. In Node, code that resolves a host itself before it connects (`node:dns`, as the URL and Linear attachment downloads do) still sends a DNS query; in Python, a reverse lookup of an address does. A test that reaches such code has to stub the lookup.
- When a command the wrapper starts resolves to a mise shim, as `yarn` can inside `mise run`, mise applies its `[env]` again after the wrapper has removed the variables. An `AWS_*` variable that comes back is refused by layer 2. A token is not checked again and stays in the jest processes, where layer 4 keeps it on the machine.
- `emulator:up` runs the container engine with the caller's environment. If Docker uses the ECR credential helper for `public.ecr.aws`, an image build asks ECR Public for a token with real credentials when it pulls the base image (a read-only call; reasoned from the tooling, not observed).
- The port is published on the host's loopback interface only, but other containers on the same Docker engine can reach it. They can also reach the ports that the emulator opens for resource endpoints, which check no request signature; the wrapper does not publish them. `RunMicrovm` opens one, also when the call is refused, and no test of the tier calls it.

## Moving the version pin

There is one pin, the `ARG AWS_EMULATOR_VERSION` line in the [Dockerfile](Dockerfile). The wrapper reads it from there, and CI builds the same file.

1. Run `ABCA_EMULATOR_VERSION=<new> mise run test:integration`, with the three-part version from the emulator's [releases](https://github.com/aws/aws-emulator/releases). ABCA's own suites on the candidate version are the gate for a bump; the release notes are the second check.
2. Edit the `ARG` line, and bring the tables and lists above up to date with what changed. The suites show only what a test asserts. The other statements hold for the release that "Recorded on emulator" names: probe them again and move that line, or leave it.
3. Remove what the move leaves behind with `docker image rm abca-aws-emulator:<tag>`: the previous pin's image, and the candidate's tag from step 1, which carries the checksum of the Dockerfile before the edit. The wrapper does not remove old images.

The image tag carries the version and a checksum of the Dockerfile, so a change to either is rebuilt. The package is verified against the AWS publishing key, pinned by fingerprint: a key rotation fails the build until the fingerprint is updated from the emulator's user guide.

Pinning is not optional. Upstream ships several releases a day and behavior changes between them: release 1.0.382 changed the `iss` claim of Cognito tokens, which the `cli` suite asserts, and release 1.0.471 changed it back. Security fixes go into the newest release only. The exposure is small by construction: the emulator is published on host loopback only, holds no real credentials or data, and the CI job has no AWS credential and no repository secret, only the job's read-only `GITHUB_TOKEN`.
