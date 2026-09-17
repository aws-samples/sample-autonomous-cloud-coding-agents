# ADR-021 workspace recovery prerequisite

`agent/src/continuation_workspace.py` adds offline capture and restoration of a
coding workspace. Together with the
[conversation checkpoint](./645-p3-session-recovery-20260917.md), it lets a new
local agent process recover its conversation and files. This is a prerequisite;
the production pipeline does not yet use either component for worker replacement.

In plain language, a Git commit saves a named version of the code. The **index**
holds changes selected for the next commit. The **working tree** contains the
files currently on disk, including changes that have not been selected or
committed. Recovery must preserve all three, rather than merely clone the last
version uploaded to GitHub.

## What the archive preserves

- A Git bundle containing reachable history, local commits, refs and tags,
  together with the current branch or detached HEAD.
- A binary staged patch and checksum of the original index entries, preserving
  the difference between staged and unstaged changes.
- The repository-local `.git/info/exclude` rules, so its ignored files remain
  ignored after restoration.
- Every regular working file, including untracked and ignored files, binary
  contents, executable permissions, directories and leaf symlinks.
- Task, attempt, approval request, owner and repository identity; the original
  absolute workspace path; and checksums for the archive and each data member.

Ignored files are included because a Git ignore rule does not prove a file is
disposable. The default limit is **1 GiB including the archive**, with **100,000
working-tree entries** and a **60-second limit per Git command**. An oversized
workspace fails capture and must keep its worker available; it is not silently
trimmed to fit.

The original `.git` administration directory is not copied. Restoration rebuilds
it from the bundle and staged patch, sets a credential-free GitHub origin URL and
the `gh` credential helper, and verifies the restored index. Original Git hooks,
config, credential headers and global configuration are not restored. Platform
Git identity and commit-attribution hooks must be installed by the future
pipeline integration. This archive does not replace the separate saved
`RepoSetup`/workflow context needed by that integration.
The local ignore file is an explicit data-only exception; symlinks to an external
ignore file are rejected. Global ignore/filter configuration still belongs to
the fresh worker's trusted setup.

The module does not read the home directory, copy authentication files from it,
or serialize environment variables. Repository contents can still contain
sensitive data, so the complete archive is private task data. A symlink is
preserved as a leaf, including an external target address, without reading the
target's contents. Archive extraction cannot write through a symlink.
External tools and home-directory caches are not captured. The future worker
setup must recreate required tool installations before using links to them.

## Capture and restore boundaries

The caller must hold the lifecycle barrier to stop agent/tool writes. Capture
also compares file metadata and Git state before and after writing. It opens
regular files through directory descriptors without following substituted
symlinks. A detected change prevents publication.

Capture writes to an owned temporary directory, validates the archive, then
publishes its completed file without replacing an existing destination. Failures
remove the temporary capture data. The original workspace is not modified.

Restore requires the expected archive checksum and identity and the original
stable workspace path, normally `/workspace/<task_id>`. It validates member
checksums, paths, types, parent relationships, manifest and Git refs before
publishing a new workspace. It rebuilds the repository offline, with hooks and
external diff helpers disabled. A failed restoration removes only its newly
created staging data; an existing workspace is never cleared.

The following currently fail with explicit feedback instead of losing state:

- Linked Git worktrees, shallow/sparse repositories, alternate object stores,
  replacement refs, submodules, merge conflicts and active Git operations.
- Intent-to-add, skip-worktree and assume-unchanged index flags.
- Hard-linked regular files, special files, mounted directories and special
  permission bits; nested `.git` entries and case-colliding paths.
- Changed or corrupt archives, another task/request's identity, a different
  workspace path, unlisted/duplicate members, path traversal and symlink parents.

`WorkspaceCheckpointError.code` identifies stages such as `size_limit`,
`entry_limit`, `unsupported_git`, `workspace_changed`, `checksum_mismatch`,
`git_timeout` and `destination_exists`. Error messages omit file contents and
raw Git stderr. The future lifecycle integration must expose these failures
without claiming that the worker can be released.

## Verification

The unit tests use real offline Git repositories. They preserve two commits,
local branches/tags, staged and unstaged binary/text edits, a staged rename,
an unstaged deletion, ignored and untracked files, executable permissions and
symlinks. Failure injection covers limits, concurrent changes, existing
destinations, unsupported states and hostile archive members.

The opt-in SDK test now uses this archive instead of copying the working
directory as a fixture:

1. Start the pinned SDK/CLI and block its original `Read` permission hook.
2. Acknowledge the exact conversation action and capture the workspace.
3. Kill the original process group and delete its configuration and workspace.
4. Restore the files from the archive and the conversation from `SessionStore`.
5. Verify approval executes one new `Read`, denial executes none, the original
   session ID is retained and the untracked marker survives.

The model is deterministic and runs on loopback. No AWS resources, paid model
service or notification channel are used by these tests.

The final source passed `ABCA_TEST_SDK_CONTINUATION=1 mise run //agent:quality`:
lint, formatting, types and **2,054 tests**, with **11 skipped** and **86.66%**
total coverage. This includes **50 workspace tests** and both composed SDK cases.
The skipped tests are the existing opt-in DynamoDB Local cases; the one warning
is Starlette's existing `httpx` test-client deprecation.

The agent Bandit high-severity scan, staged secrets scan and silent-success scan
for changes since `f9ee0b49` passed. The full repository silent-success scan's
previously recorded findings are not claimed fixed by this patch.

The source snapshot, final test logs, actual SDK model requests, hook audits,
workspace/conversation archives and checksums are retained under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/workspace-checkpoint`.

## Remaining integration

The archive is local only. It must still be uploaded under scoped permissions,
read back and pinned to an immutable object version. The existing conversation
S3 adapter accepts its JSON envelope and **does not upload this tar archive**.
Both receipts must be conditionally published together for the owning attempt
before any worker release.

Production work still includes saved workflow/baseline context, fresh credential
setup, restoring without the destructive fresh-clone path, worker-attempt
fencing, capacity transfer and replacement cloud-worker acceptance. Approval
deadlines and normal automatic sleep are unchanged. See the
[P3 implementation order](./645-p3-implementation-plan.md#unanswered-approvals-implementation-order).
