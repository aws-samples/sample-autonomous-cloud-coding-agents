// Base catch-all permit. Without it, cedarpy's default-deny would turn
// every non-matching Cedar evaluation on this tier into a DENY decision,
// making the soft tier indistinguishable from hard-deny. With it, Cedar
// returns ALLOW (no matching forbid) and our engine's STEP 3 sees only
// the genuine forbid hits as REQUIRE_APPROVAL.
@rule_id("base_permit")
permit (principal, action, resource);

// Built-in soft-deny policy set for Cedar HITL engine.
//
// Soft-deny is the HUMAN-IN-THE-LOOP surface: matching rules pause the
// tool call, write an approval request to DynamoDB, and await a human
// response via `bgagent approve` / `bgagent deny`. See
// docs/design/CEDAR_HITL_GATES.md §§2, 6, 15.4.
//
// Every rule in this file MUST carry:
//   @tier("soft")
//   @rule_id("...")         — stable ID for --pre-approve rule:X
//   @approval_timeout_s     — integer seconds >= 30 (<120 emits WARN per IMPL-25)
//   @severity               — "low" | "medium" | "high"
//   @category               — optional free-form UX grouping
//
// Blueprints may OPT OUT of specific rules here via
// `security.cedarPolicies.disable: [rule_id]`. They may NOT disable any
// rule in hard_deny.cedar (blueprint loader rejects those at task start).

// Gate any git --force / -f push. Medium severity. Each built-in rule allows the
// platform maximum (3600s), so the task's window decides (default 1800s, per repo
// via security.approvalTimeoutSeconds, per task via approval_timeout_s).
// Covers both long-form (--force) and short-form (-f) variants, including
// the bare `git push -f` invocation with no branch argument, and the flag
// after the remote and branch (`git push origin feature --force`). After
// the branch, `-f` is matched at the end of the command or of a line and
// before `;`, `&`, `|`, `>` or ` 2>`, as in
// `git push origin feature -f 2>&1 | tail -5`: followed by other text it
// is also the flag of a later program (`&& gh api ... -f ...`). Directly
// after `git push`, `-f` is matched whatever follows it, as in
// `git push -f;echo ok` or `git push -fu origin feature`: git push has no
// other option that begins with `-f`.
@tier("soft")
@rule_id("force_push_any")
@approval_timeout_s("3600")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push --force*"
    || context.command like "*git push -f*"
    || context.command like "*git push * --force*"
    || context.command like "*git push * -f"
    || context.command like "*git push * -f\n*"
    || context.command like "*git push * -f;*"
    || context.command like "*git push * -f ;*"
    || context.command like "*git push * -f&*"
    || context.command like "*git push * -f &*"
    || context.command like "*git push * -f|*"
    || context.command like "*git push * -f |*"
    || context.command like "*git push * -f>*"
    || context.command like "*git push * -f >*"
    || context.command like "*git push * -f 2>*" };

// Force-push to main/prod specifically — higher severity.
// Multi-match with force_push_any is expected: the engine's annotation
// merging picks the shorter window (both 3600s, capped by the task's) and
// max(medium, high)=high.
@tier("soft")
@rule_id("force_push_main")
@approval_timeout_s("3600")
@severity("high")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push --force origin main*"
    || context.command like "*git push --force origin prod*"
    || context.command like "*git push -f origin main*"
    || context.command like "*git push -f origin prod*" };

// Non-force pushes to protected branches — catches the case where an
// agent bypasses PR workflow by pushing directly.
@tier("soft")
@rule_id("push_to_protected_branch")
@approval_timeout_s("3600")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push origin main*"
    || context.command like "*git push origin master*"
    || context.command like "*git push origin prod*"
    || context.command like "*git push origin release/*" };

// Writes to `.env` files typically contain secrets. High severity.
@tier("soft")
@rule_id("write_env_files")
@approval_timeout_s("3600")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*.env" };

// Writes to any path containing "credentials" — SSH keys, AWS creds,
// service-account JSON, etc. High severity.
@tier("soft")
@rule_id("write_credentials")
@approval_timeout_s("3600")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*credentials*" };
