# ADR-021 pending approval session recovery

A local diagnostic on September 17 verified that the pinned agent SDK can resume
a saved conversation in a new process after its original process dies while
waiting in a tool hook. It does **not** resume that pending hook. This is one
prerequisite for retaining unanswered approvals beyond a worker's lifetime;
production continuation remains unimplemented.

## What was exercised

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

## Limits and next steps

This test proves local SDK conversation recovery with an abrupt process loss and
a copied workspace/configuration directory. Its deterministic model demonstrates
the transport behavior; it does not prove how a real model will interpret the
continuation prompt.

The probe does not yet verify recovery on a replacement cloud worker, portable
workspace paths, durable object storage, exclusion of credentials from a
production checkpoint, task-attempt fencing, exactly-once decision consumption,
denial, cancellation or loss of a checkpoint/launch response. Those remain part
of the [unanswered-approval implementation order](./645-p3-implementation-plan.md#unanswered-approvals-implementation-order).

The executable probe, exact model requests, hook audits, copied synthetic session
files and verification result are archived with a SHA-256 manifest under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/session-recovery`.
