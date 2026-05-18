# Cedar policy guide

This guide is for **blueprint authors** — repo owners writing the Cedar policies that govern what tool calls the agent can make unattended versus which ones pause for human approval.

> **If you are a task submitter** looking for how approvals work at the CLI, see [User guide — Approval gates](./USER_GUIDE.md#approval-gates-cedar-hitl). This guide is about *writing* the rules that cause approvals.
>
> **For the full design** (fail-closed posture, engine internals, concurrency), see [Cedar HITL gates design doc](../design/CEDAR_HITL_GATES.md).

## Two tiers, one language

Every Cedar policy in a blueprint is tagged with `@tier("hard")` or `@tier("soft")`:

- **Hard-deny** rules are absolute. A matching tool call is rejected; nothing — not `--pre-approve`, not the `all_session` scope — bypasses them. Use for policies that should never be overridable (e.g. `rm -rf /`, writes to `.git/`).
- **Soft-deny** rules pause the agent and ask a human. On approval the tool call proceeds; on denial the agent receives the deny reason and is expected to adapt.

Both tiers use the same Cedar syntax. The annotation is all that differs.

## Where rules live

A blueprint's `security.cedarPolicies` field in `blueprint.yaml` is concatenated with the platform's built-in rules:

```yaml
security:
  cedarPolicies:
    hard: |
      @tier("hard")
      @rule_id("block_prod_writes")
      forbid (principal, action == Agent::Action::"write_file", resource)
        when { context.file_path like "prod/**" };
    soft: |
      @tier("soft")
      @rule_id("deploy_staging")
      @severity("high")
      @approval_timeout_s("900")
      @category("destructive")
      forbid (principal, action == Agent::Action::"execute_bash", resource)
        when { context.command like "*terraform apply*" };
    disable:
      # Opt-out of built-in soft-deny rules you don't want.
      # You CANNOT disable built-in hard-deny rules — the platform rejects that at task start.
      - write_env_files
  maxPreApprovalScope: "tool_type_session"   # optional cap on what --pre-approve can grant
  approvalGateCap: 50                         # optional per-task gate budget (1–500, default 50)
```

The built-in rule set is documented in [`agent/policies/hard_deny.cedar`](../../agent/policies/hard_deny.cedar) and [`agent/policies/soft_deny.cedar`](../../agent/policies/soft_deny.cedar). Run `bgagent policies list --repo owner/repo` against a deployed stack to see the effective rules for a repo.

## Vocabulary

Every tool call the agent makes is evaluated as a Cedar `(principal, action, resource, context)` tuple. The platform fills in:

| Element | Values you'll see in rules |
|---|---|
| **action** | `Agent::Action::"execute_bash"` — any Bash command<br>`Agent::Action::"write_file"` — Write + Edit tool calls<br>`Agent::Action::"invoke_tool"` — catch-all for other tools |
| **context.command** | For `execute_bash`: the command string |
| **context.file_path** | For `write_file`: the target path (repo-relative or absolute) |

`principal` and `resource` are present for future vocabulary extension; today's rules use them only as positional placeholders.

## Annotation reference

| Annotation | Required? | Values | Purpose |
|---|---|---|---|
| `@rule_id("...")` | **Yes on soft-deny** (recommended on hard-deny) | Unique kebab/snake-case identifier | Stable ID for `--pre-approve rule:X`, for audit events, and for `bgagent policies show --rule X`. Engine rejects duplicates at task start. |
| `@tier("hard"\|"soft")` | **Yes** | Exactly one of `"hard"` or `"soft"` | Must match the file section. Mismatches fail task start. |
| `@approval_timeout_s("N")` | No | Integer seconds ≥ 30 | Per-rule timeout. Defaults to 300 s (overridable per-task via `--approval-timeout`). When multiple soft rules match, the engine picks the minimum. Values < 120 s emit a load-time warning; values < 30 s are rejected. Ignored on hard-deny. |
| `@severity("low"\|"medium"\|"high")` | No | One of three | Displayed in the approval prompt. Default: `medium`. |
| `@category("...")` | No | `destructive`, `network`, `filesystem`, `auth`, or free-form | Optional UX grouping. Not enforced. |

**Rule of thumb:** every soft-deny rule must have `@rule_id` and should set `@severity` + `@approval_timeout_s` explicitly. Users scanning `bgagent pending` lean on these fields to triage quickly.

## Common patterns

### Block absolute dangers (hard-deny)

```cedar
@tier("hard")
@rule_id("rm_slash")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*rm -rf /*" };

@tier("hard")
@rule_id("write_git_internals")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like ".git/*" };
```

### Gate destructive git ops (soft-deny, high severity)

```cedar
@tier("soft")
@rule_id("force_push_main")
@severity("high")
@approval_timeout_s("600")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*git push --force origin main*"
      || context.command like "*git push -f origin main*" };
```

### Protect sensitive paths (soft-deny)

```cedar
@tier("soft")
@rule_id("write_env_files")
@severity("high")
@approval_timeout_s("600")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*.env" };
```

### Ask before running migrations

```cedar
@tier("soft")
@rule_id("run_migrations")
@severity("high")
@approval_timeout_s("900")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*alembic upgrade*"
      || context.command like "*rails db:migrate*"
      || context.command like "*knex migrate:latest*" };
```

## Multi-match behavior

A single tool call can match several rules. When that happens the engine merges them:

- **Timeout** — the minimum of all matching rules' `@approval_timeout_s` values (smallest window wins).
- **Severity** — the maximum across matches (`high` > `medium` > `low`).
- **`matching_rule_ids`** — the full set, so the CLI can show the user every rule that fired.

If a hard-deny rule matches, any soft-deny matches are ignored — hard-deny short-circuits the evaluation.

## What fails at task start

The blueprint loader runs a probe Cedar evaluation before the task is admitted. Any of the following cause task-start failure with a clear error, never silent fall-through:

- Malformed Cedar syntax.
- Duplicate `@rule_id` across hard + soft tiers.
- `@tier` value that doesn't match the file section it was written in.
- Missing `@rule_id` on a soft-deny rule.
- `@approval_timeout_s` below the 30 s floor or non-integer.
- `disable:` entry that names a built-in hard-deny rule (absolute by design) or a nonexistent rule ID.
- Combined hard + soft Cedar text exceeding 64 KB.

Fix the blueprint, redeploy (or update the `blueprint.yaml` if you're using a pulled blueprint), resubmit.

## Capacity and UX budgets

- **`approvalGateCap`** (1–500, default 50) — per-task ceiling on how many gates can fire before the task is force-terminated. It's a circuit breaker for runaway policy matches, not a rate limit for humans. Raise it for long migrations; lower it for high-risk blueprints.
- **`maxPreApprovalScope`** — optional upper bound on what `--pre-approve` is allowed to seed. If set to `tool_type_session`, a user can't pre-approve `all_session` from the CLI.

## Testing policies before shipping

Every repo blueprint is covered by **cross-engine parity fixtures** in [`contracts/cedar-parity/`](../../contracts/cedar-parity/). Before shipping a non-trivial rule change, drop a golden-file fixture that pins the expected `(decision, matching_rule_ids)` for a representative `(policies, input)` pair. Both the Python `cedarpy` engine and the TypeScript `@cedar-policy/cedar-wasm` engine run it — divergence fails CI. See the directory's README for the fixture schema.

For unit coverage of your own rules without the cross-engine guarantee, add a case to [`agent/tests/test_policy.py`](../../agent/tests/test_policy.py) using `PolicyEngine.evaluate_tool_use(...)`.

## Where to look next

- [`docs/design/CEDAR_HITL_GATES.md`](../design/CEDAR_HITL_GATES.md) — full design: engine internals, fail-closed posture, late-approval races, concurrency.
- [`agent/policies/hard_deny.cedar`](../../agent/policies/hard_deny.cedar) + [`agent/policies/soft_deny.cedar`](../../agent/policies/soft_deny.cedar) — the built-in rule set, good starting point for copy-paste.
- [User guide — Approval gates](./USER_GUIDE.md#approval-gates-cedar-hitl) — the CLI side (`bgagent pending` / `approve` / `deny` / `policies`).
