# ADR-021 pending approval session recovery

September 17 diagnostics verified that the pinned agent SDK can resume a saved
conversation in a new process after its original process dies while waiting in
a tool hook. It does **not** resume that pending hook. The implemented SDK
conversation store now retains the exact proposed action alongside the session;
approve and deny passed after deleting the original configuration. Nine live
S3 checks also passed, including task isolation and reads pinned to an immutable
object version. These are prerequisites for retaining unanswered approvals
beyond a worker's lifetime; production continuation remains unimplemented.

## Initial recovery diagnostic

The probe used Python `claude-agent-sdk` **0.2.110** and its bundled Claude Code
**2.1.191**, matching the reviewed application versions. The model endpoint was
a loopback HTTP server returning deterministic responses. AWS credentials were
synthetic, configuration directories were isolated, and the only available tool
was `Read` against an owned temporary marker file. No model service, repository
or notification channel was contacted.

1. The first process received a model response proposing `Read`, with tool ID
   `toolu_original`. Its `PreToolUse` callback remained blocked.
2. The probe waited until the assistant tool call appeared in the saved session
   file, then copied the session directory and workspace.
3. It killed the original process group, including the bundled CLI. No
   `PostToolUse` callback occurred in that process.
4. It restored the workspace at the same path and started a separate process
   with the copied configuration and `ClaudeAgentOptions.resume` set to the
   original session ID.
5. A new user turn told the agent that a decision had arrived. The simulated model
   proposed a new `Read`, ID `toolu_restored`. That call passed through a new
   permission hook, read the restored marker once, and completed in the same
   conversation session.

## What recovery preserved

The restored model request contained the original user prompt and the new
continuation prompt. The original pending tool call was absent; its assistant
turn was represented as `No response requested.` The new tool call had a new ID.
The session ID remained `bb94901c-a91f-4854-8e63-edbc7a476f91`.

Therefore, passing `resume=<session_id>` is not sufficient to consume the saved
approval or recover its exact proposed action. The application must retain that
request identity, action and decision separately and make them available to the
agent after restoration. Newly proposed tool calls still pass through the normal
authorization hooks. The recorded approval must not become blanket permission
for a different action.

This requirement does not add a separate relevance or staleness checker. The
agent assesses relevance through its ordinary reasoning, as requested.

## Supported conversation checkpoint implementation

The initial configuration-copy diagnostic established the SDK behavior. The new
`agent/src/continuation_session.py` uses the SDK's supported `SessionStore`
contract instead. It never reads or copies CLI configuration or authentication
files.

- `CheckpointSessionStore.append()` preserves opaque SDK journal entries, updates
  existing UUID entries in place and retains entries without UUIDs. It rejects
  mixed sessions and subagent transcripts; detached/subagent work is outside the
  current runner's supported waiting state.
- With `session_store_flush="eager"`, the SDK still mirrors asynchronously.
  `checkpoint_pending()` waits for the exact assistant tool ID, name and full
  input to appear. A missing batch, mismatch or existing tool result prevents
  acknowledgement. A rejected batch poisons the buffer, so later data cannot
  conceal the possible gap.
- The versioned envelope contains task, attempt, request, user and repository
  identity; SDK project/session identity; full pending action and its approval-row
  compatible hash; and transcript entries. It is bounded to 16 MiB and 50,000
  entries. Extra top-level configuration or environment fields are rejected.
- `S3ContinuationCheckpoints.save()` conditionally creates a SHA-256-addressed
  object with encryption and checksum. It returns a receipt only after checking
  the exact bytes and a real S3 version. A lost write reply or repeated save can
  recover through read-back; failure to prove persistence never reports success.
- `load()` reads the receipt's exact version, validates its checksum, size,
  envelope and identity, then supplies the journal to a new store for SDK
  materialization. Later changes to the current object cannot change that
  version's saved data.

Storage uses `continuations/<task_id>/<attempt_id>/<request_id>/<sha256>.json`.
The default AWS client requires an active task-scoped session before using the
attributed factory. This explicit check matters because `tenant_client()` alone
can fall back to ambient credentials. The future deployment needs a private,
versioned bucket and `PutObject`, `GetObject`, `GetObjectVersion` permission only
under the task's prefix. Existing artifact-write permissions are insufficient.
This component does not configure retention or delete checkpoints.

Transcript and action contents remain private task data and may themselves
contain sensitive text. Excluding authentication files does not mean the
conversation is safe to log or publish.

## Real SDK approve and deny checks

`agent/tests/test_continuation_sdk_probe.py` uses the same SDK **0.2.110** and CLI
**2.1.191** with synthetic AWS credentials and a deterministic loopback model:

1. The original `Read` hook waits for the new store to acknowledge the exact
   proposed action and writes that checkpoint.
2. The test kills the entire original process group, verifies that its tool did
   not execute, and deletes the original configuration directory.
3. The initial store test copied an owned marker as its workspace fixture. The
   [workspace follow-up](./645-p3-workspace-recovery-20260917.md) now deletes the
   original workspace and restores its Git history, tracked marker and untracked
   file using the new archive component. A fresh process starts at the same
   path with `resume`, the restored store and eager mirroring.
4. The continuation prompt carries the full saved action and human decision.
   The model proposes `toolu_restored`; the fresh permission hook allows one
   `Read` for approval and denies it for denial. Both sessions complete with
   their original session ID.
5. A synthetic authentication-file sentinel is absent from the saved checkpoint.
   No original CLI configuration is used during restoration.

The initial conversation-component full agent quality run enabled both tests:

```bash
ABCA_TEST_SDK_CONTINUATION=1 MISE_EXPERIMENTAL=1 mise run //agent:quality
```

Lint, formatting and type checks passed; **2,004 tests passed, 11 skipped**, with
86.57% total coverage. This includes **45 checkpoint unit tests** and both real SDK
cases. The skipped cases are the existing opt-in DynamoDB Local checks. One
dependency warning concerns Starlette's deprecated `httpx` test-client support.
Unit failure injection covers dropped mirror data, corrupt or cross-task
checkpoints, cancelled waits, ambiguous write replies and unverifiable storage.
The agent Bandit high-severity check and documentation build passed. The full
repository silent-success scan reported 92 findings in 50 files unchanged from
the pre-change commit `95fd6746`; none were in this component. The corresponding
change-only scan against that commit passed.

## Live S3 verification and cleanup

The isolated AWS probe used the development account, region `us-west-2`, private
versioned bucket `abca-645-checkpoint-<account-id>-20260917` and role
`abca-645-checkpoint-probe-20260917`. The role allowed only
`PutObject`, `GetObject` and `GetObjectVersion` under
`continuations/${aws:PrincipalTag/task_id}/*`, with task/user/repository session
tags. It used a real checkpoint produced by the SDK test above.

| Check | Result |
| --- | --- |
| Save, read and repeat the same save | Same verified version receipt |
| Object encryption and SHA-256 checksum | AES256 and matching checksum |
| Overwrite current object, then load saved receipt | Original version and bytes restored |
| Another task reads current object | Access denied |
| Another task reads pinned version | Access denied |
| Another task writes this task's prefix | Access denied |
| Owning task lists the bucket | Access denied |
| Owning task deletes current object | Access denied |
| Owning task deletes pinned version | Access denied |

All nine checks passed. Cleanup verified ownership tags, removed both exact
object versions, the bucket, inline policy and role, and confirmed bucket `404`
and role `NoSuchEntity`. No normal deployment resource or setting changed.

## Limits and next steps

These tests prove local SDK conversation recovery after abrupt process loss,
explicit transfer of the action/decision, and the S3 storage contract under real
task-scoped permissions. The deterministic model demonstrates transport and hook
behavior; it does not prove how a real model will interpret the continuation
prompt.

Production `runner.py` does not yet install this store or resume from it. The
workspace follow-up implements local file/Git preservation; its durable storage
and integration remain required. Other remaining work includes recovery on a
replacement cloud worker; enforcing the stable workspace path; lifecycle barrier and
conditional publication of the acknowledged receipt; task-attempt fencing and
reservation transfer; exactly-once decision consumption; cancellation while
parked; lost launch replies; and request retention/deadline changes. A conversation
receipt alone never permits worker release. Those requirements remain in the
[unanswered-approval implementation order](./645-p3-implementation-plan.md#unanswered-approvals-implementation-order).

The initial executable probe, model requests, hook audits and synthetic session
files are archived with a SHA-256 manifest under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/session-recovery`.
The new implementation snapshot, SDK fixtures, test logs and live S3 policy,
verification and cleanup receipts are archived separately under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/continuation-checkpoint`.
