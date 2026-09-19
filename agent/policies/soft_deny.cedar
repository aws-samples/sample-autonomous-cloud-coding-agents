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
//   @severity               — "low" | "medium" | "high"
//   @category               — optional free-form UX grouping
// An optional @approval_timeout_s sets a positive explicit deadline (>= 30s).
// Omitting it uses the task setting, whose default is no automatic expiry.
//
// Blueprints may OPT OUT of specific rules here via
// `security.cedarPolicies.disable: [rule_id]`. They may NOT disable any
// rule in hard_deny.cedar (blueprint loader rejects those at task start).

// Gate any git --force / -f push, with medium severity.
// Covers both long-form (--force) and short-form (-f) variants, including
// the bare `git push -f` invocation with no branch argument.
@tier("soft")
@rule_id("force_push_any")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push --force*"
    || context.command like "*git push -f *"
    || context.command like "*git push -f" };

// Force-push to main/prod specifically — higher severity.
// Multi-match with force_push_any is expected: the engine's annotation
// merging picks max(medium, high)=high. There is no implicit approval expiry.
@tier("soft")
@rule_id("force_push_main")
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
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*.env" };

// Writes to any path containing "credentials" — SSH keys, AWS creds,
// service-account JSON, etc. High severity.
@tier("soft")
@rule_id("write_credentials")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*credentials*" };
