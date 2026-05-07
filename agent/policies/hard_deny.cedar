// Built-in hard-deny policy set for Cedar HITL engine.
//
// Hard-deny is ABSOLUTE: no --pre-approve scope and no blueprint `disable:`
// directive can bypass these rules. See docs/design/CEDAR_HITL_GATES.md
// §12.5 and decision #8.
//
// Every rule in this file MUST carry @tier("hard") + @rule_id annotations.
// Adding a rule here expands the set of categorically-forbidden agent
// actions; removing a rule requires a security review.

// Base catch-all permit. Specific forbid rules below override.
@rule_id("base_permit")
permit (principal, action, resource);

// pr_review tasks may never invoke Write. Absolute; cannot be overridden
// by per-blueprint customization or --pre-approve.
@tier("hard")
@rule_id("pr_review_forbid_write")
forbid (
    principal == Agent::TaskAgent::"pr_review",
    action == Agent::Action::"invoke_tool",
    resource == Agent::Tool::"Write"
);

// pr_review tasks may never invoke Edit.
@tier("hard")
@rule_id("pr_review_forbid_edit")
forbid (
    principal == Agent::TaskAgent::"pr_review",
    action == Agent::Action::"invoke_tool",
    resource == Agent::Tool::"Edit"
);

// Reject `rm -rf /` and similar absolute-root destructive commands.
@tier("hard")
@rule_id("rm_slash")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*rm -rf /*" };

// Reject writes into `.git/` at the repo root (breaks local git state).
@tier("hard")
@rule_id("write_git_internals")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like ".git/*" };

// Reject writes into nested `.git/` directories (submodules, worktrees).
@tier("hard")
@rule_id("write_git_internals_nested")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*/.git/*" };

// Reject any SQL DROP TABLE through Bash — agents should not be running
// destructive DDL against production or dev databases without a human
// in the loop. Hard-deny because even "just testing locally" is a common
// vector for data loss (wrong DB connected via saved credentials).
@tier("hard")
@rule_id("drop_table")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*DROP TABLE*" };
