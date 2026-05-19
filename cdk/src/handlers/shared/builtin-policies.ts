/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * Built-in Cedar HITL policy text mirrored from `agent/policies/`.
 *
 * Kept in sync with `agent/policies/hard_deny.cedar` and
 * `agent/policies/soft_deny.cedar` so Lambda-side handlers (get-policies,
 * create-task rule-id validation) see the same rule set the agent's
 * cedarpy engine sees. The parity contract
 * (`contracts/cedar-parity/*.json`) catches decision-level drift; a
 * dedicated drift test (`cdk/test/handlers/shared/builtin-policies.test.ts`)
 * asserts byte-equality so text drift cannot silently diverge.
 *
 * Why embed instead of read from disk:
 *   - Lambda bundling with `esbuild` does not copy non-TS assets by
 *     default; adding a bundling asset hook just for two small files
 *     is more code than the embed.
 *   - Embed keeps cold-start zero-cost — no `fs.readFileSync` on the
 *     hot path.
 *   - Drift is caught by the test at build time, before deploy.
 *
 * If these policies ever become blueprint-overridable per-repo, the
 * caller should pass the resolved text directly to `parseRules`;
 * these constants remain the platform default.
 */

export const BUILTIN_HARD_DENY_POLICIES = `// Built-in hard-deny policy set for Cedar HITL engine.
//
// Hard-deny is ABSOLUTE: no --pre-approve scope and no blueprint \`disable:\`
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

// Reject \`rm -rf /\` and similar absolute-root destructive commands.
@tier("hard")
@rule_id("rm_slash")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*rm -rf /*" };

// Reject writes into \`.git/\` at the repo root (breaks local git state).
@tier("hard")
@rule_id("write_git_internals")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like ".git/*" };

// Reject writes into nested \`.git/\` directories (submodules, worktrees).
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
`;

export const BUILTIN_SOFT_DENY_POLICIES = `// Base catch-all permit. Without it, cedarpy's default-deny would turn
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
// response via \`bgagent approve\` / \`bgagent deny\`. See
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
// \`security.cedarPolicies.disable: [rule_id]\`. They may NOT disable any
// rule in hard_deny.cedar (blueprint loader rejects those at task start).

// Gate any git --force / -f push. 300s default approval window, medium severity.
// Covers both long-form (--force) and short-form (-f) variants, including
// the bare \`git push -f\` invocation with no branch argument.
@tier("soft")
@rule_id("force_push_any")
@approval_timeout_s("300")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push --force*"
    || context.command like "*git push -f *"
    || context.command like "*git push -f" };

// Force-push to main/prod specifically — longer window, higher severity.
// Multi-match with force_push_any is expected: the engine's annotation
// merging picks min(300, 600)=300s and max(medium, high)=high.
@tier("soft")
@rule_id("force_push_main")
@approval_timeout_s("600")
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
@approval_timeout_s("300")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
when { context.command like "*git push origin main*"
    || context.command like "*git push origin master*"
    || context.command like "*git push origin prod*"
    || context.command like "*git push origin release/*" };

// Writes to \`.env\` files typically contain secrets. 600s window, high severity.
@tier("soft")
@rule_id("write_env_files")
@approval_timeout_s("600")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*.env" };

// Writes to any path containing "credentials" — SSH keys, AWS creds,
// service-account JSON, etc. 300s window, high severity.
@tier("soft")
@rule_id("write_credentials")
@approval_timeout_s("300")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
when { context.file_path like "*credentials*" };
`;
