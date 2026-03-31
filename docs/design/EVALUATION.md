# Evaluation pipeline

This document describes how the platform evaluates agent performance and uses that feedback to improve over time. It aligns with the design principle that the system should be easy to observe and improve. The evaluation pipeline is a **future** enhancement; MVP relies on manual inspection of task outcomes and logs.

## Purpose

- **Measure agent quality** — How well does the agent follow instructions, avoid reasoning errors, and produce correct, testable outcomes?
- **Learn from failures** — Categorize why tasks fail (timeout, missing tests, wrong approach, tool errors) and feed that back into prompts or memory so future runs avoid the same mistakes.
- **Improve over time** — Use evaluation results to tune system prompts, context hydration, and (future) model or tool selection.

## What to evaluate

The plans call for automated **trace analysis** and **failure categorization**:

- **Reasoning errors** — Agent went down a wrong path, misunderstood the task, or made incorrect assumptions.
- **Failure to follow instructions** — Task spec or issue was clear but the agent did not comply (e.g. skipped tests, changed the wrong scope).
- **Missing testing or verification** — Agent did not run tests, did not run linters, or did not document how to verify the change.
- **Running out of time** — Task hit the 8-hour or idle timeout before completing; partial work may still be on the branch.
- **Tool or environment failures** — GitHub API errors, clone failures, build failures that the agent could not recover from.

Evaluation can be **manual** (human review of PRs and logs) or **automated** (scripts or ML that analyze traces, PR content, and task outcomes). The pipeline is the place where automated analysis runs and writes structured results.

## Data sources

- **Task outcomes** — Status (COMPLETED, FAILED, TIMED_OUT), `error_message`, `pr_url`, branch state.
- **TaskEvents** — Audit log of what happened (agent_started, pr_created, task_completed, task_failed, etc.).
- **Agent logs and traces** — CloudWatch logs from the AgentCore Runtime session; future: OpenTelemetry traces, reasoning steps, tool calls (if captured and stored).
- **Code artifacts** — PR description, commits, diff; links to repo, branch, and issue (code attribution).
- **PR outcome signals** — Whether the PR was merged, revised, or rejected. Tracked via GitHub webhooks for `pull_request.closed` events (checking the `merged` flag). A merged PR is a positive signal on the task episode; a PR closed without merge is a negative signal. Over time, these outcome signals enable the evaluation pipeline to identify which approaches succeed and which fail for a given repo, and to correlate outcomes with prompt versions, memory state, and context hydration quality. See [MEMORY.md](./MEMORY.md) (PR outcome signals).
- **Review feedback** — PR review comments captured via the review feedback memory loop (see [MEMORY.md](./MEMORY.md)). Reviewer comments, requested changes, and approval/rejection status are structured evaluation data: they encode what the agent got wrong and what the team expects.

These are the same data that observability and code attribution capture. Evaluation consumes them to produce **scores**, **categories**, or **recommendations**.

## Outputs and feedback loop

- **Structured evaluation results** — Per task: success/failure, category, suggested prompt or memory updates.
- **Feedback into memory** — Insights (e.g. “this repo’s tests require env X”) or failure summaries written to AgentCore Memory so they can be retrieved during context hydration for future tasks.
- **Feedback into prompts** — System prompt or hydration templates updated to avoid known failure modes (e.g. “always run tests before opening PR” or “for repo X, run lint with --fix first”).

See [MEMORY.md](./MEMORY.md) for how insights and evaluation feedback are stored and used. See [OBSERVABILITY.md](./OBSERVABILITY.md) for the “Future: evaluation pipeline” section and how observability data feeds evaluation.

## Agent self-feedback

At the end of each task, the platform explicitly prompts the agent to report what context it lacked. In practice, the agent can often identify missing context that affected execution quality. This is a lightweight, high-value signal source.

- **Mechanism** — After the agent completes its work (success or failure) but before the session ends, the orchestrator (or agent harness) sends a follow-up prompt: *"What information, context, or instructions were missing that would have helped you complete this task more effectively?"* The agent's response is captured as a structured insight.
- **Storage** — The response is persisted in long-term memory (see [MEMORY.md](./MEMORY.md)) with metadata: `task_id`, `repo`, `insight_type: "agent_self_feedback"`, `timestamp`. This enables retrieval during context hydration for future tasks on the same repo.
- **Feedback loop** — Over time, recurring themes in agent self-feedback (e.g. "I needed to know that this repo uses a custom linter") can be surfaced in evaluation dashboards and used to update per-repo system prompts or onboarding artifacts. The evaluation pipeline can aggregate self-feedback by repo and extract patterns.
- **Cost** — The follow-up prompt is a single additional turn (minimal token cost). The value of the signal justifies the cost.

## Prompt versioning and A/B evaluation

System prompts (platform default + per-repo overrides) should be treated as **versioned, testable artifacts**, not opaque strings. Static, version-controlled prompts are generally more evaluable than ad hoc prompt assembly.

- **Prompt versioning** — Each system prompt variant is stored with a version identifier (hash or semantic version). When a task is created, the `prompt_version` is recorded in the task record (see [ORCHESTRATOR.md](./ORCHESTRATOR.md) data model). This enables correlation: "did merge rates improve after prompt version X was deployed for repo Y?"
- **A/B comparison (future)** — A framework for running the same task type with two prompt variants and comparing outcomes (merge rate, failure rate, token usage, duration). This requires: (a) a way to assign tasks to prompt variants (e.g. random split or deterministic by task ID), (b) outcome tracking per variant, and (c) a comparison dashboard. Deferred to Iteration 5; the versioning and correlation capability (Iteration 3b) is the foundation.
- **Prompt change tracking** — Prompt diffs between versions should be reviewable (like code diffs). Store prompt versions in a versioned store (e.g. DynamoDB with version history, or as files in the repo's onboarding config). This supports audit and rollback.

## Memory effectiveness metrics

The primary measure of memory's value is: **does the agent produce better PRs over time?** These metrics track that:

| Metric | How to measure | What improvement looks like |
|---|---|---|
| **First-review merge rate** | % of PRs merged without revision requests | Increases over time on the same repo |
| **Revision cycles** | Average number of review rounds before merge | Decreases over time |
| **CI pass rate on first push** | % of PRs where CI passes on the initial push | Increases as the agent learns repo-specific build quirks |
| **Review comment density** | Number of reviewer comments per PR | Decreases as the agent internalizes review patterns |
| **Repeated mistakes** | Same reviewer comment appearing across multiple PRs | Should drop to zero after the feedback loop captures the rule |
| **Time to PR** | Duration from task submission to PR creation | May decrease as the agent reuses past approaches |

The most telling metric is **repeated mistakes**. If a reviewer says "don't use `any` types" on PR #10 and the agent uses `any` types again on PR #15, the review feedback memory has failed. This metric requires tracking review comments across PRs and detecting semantic duplicates.

**Semantic similarity dependency:** Detecting repeated mistakes requires **embedding-based similarity** between review comments — simple string matching is insufficient ("don't use `any`" vs. "please use proper TypeScript types instead of `any`" are the same feedback). Implementation approach:
- The review feedback extraction prompt (see [MEMORY.md](./MEMORY.md), Extraction prompts) should normalize comments into **canonical rule forms** (e.g. "Rule: use explicit TypeScript types, not `any`") to make downstream deduplication easier.
- New review comments are compared against the history of stored rules using embedding similarity (Bedrock embedding model or AgentCore's built-in semantic search). A similarity score above a threshold (e.g. 0.85) indicates a repeated mistake.
- This is a lightweight ML task that runs as part of the evaluation pipeline, not a separate system.

These metrics should be surfaced in the evaluation dashboard (Iteration 4/5) and broken down by repo, user, and prompt version. Correlating metrics with prompt versions (see Prompt versioning above) enables data-driven prompt improvement.

## Tiered validation pipeline

The platform validates agent-created content through three sequential tiers before a PR is finalized. Each tier targets a different class of defect, from concrete tool failures to structural quality issues to cross-codebase impact. The tiers run as post-agent steps in the blueprint execution framework (see [REPO_ONBOARDING.md](./REPO_ONBOARDING.md#blueprint-execution-framework)).

### Tier 1 — Tool validation (build, test, lint)

**What it checks:** Deterministic, binary pass/fail signals from the repo's own tooling.

- Test suites (`npm test`, `pytest`, `go test`, etc.)
- Linters and formatters (`eslint`, `ruff`, `prettier`, etc.)
- Type checkers (`tsc --noEmit`, `mypy`, `pyright`)
- SAST scanners (e.g. `semgrep`, `bandit`, custom scripts)
- Build verification (`npm run build`, `cargo build`)

**Implementation:** The orchestrator invokes a post-agent Lambda (or runs commands inside the agent session before finalization) that executes the repo's configured validation commands. Validation commands are discovered during onboarding (from `package.json` scripts, `Makefile` targets, CI config) or explicitly configured in the blueprint's `custom_steps`.

**On failure:** Tool output (test failures, lint errors) is fed back to the agent for a fix cycle (up to 2 retries). If the agent cannot fix the issues, the PR is created with the failures documented in the validation report.

**Status:** Partially implemented — the system prompt already instructs the agent to run tests and fix errors (in-session retry, option (c) from [ORCHESTRATOR.md Q6](./ORCHESTRATOR.md#q6-post-agent-validation-and-retry-cycles)). The orchestrator-driven post-agent step (option (b)) is the Iteration 3c enhancement.

### Tier 2 — Code quality analysis

**What it checks:** Structural and design quality of the agent's diff, beyond what linters catch.

| Quality dimension | What to detect | Example finding |
|---|---|---|
| **DRY violations** | Duplicated or near-duplicated code blocks introduced by the agent | "Lines 45–62 in `auth.ts` duplicate the logic in `session.ts:30–47`. Extract a shared helper." |
| **SOLID violations** | Single responsibility breaches, interface segregation issues, dependency inversion gaps | "Class `TaskHandler` now handles both validation and persistence — consider splitting." |
| **Design pattern adherence** | Deviations from patterns established in the codebase (factory, strategy, repository, etc.) | "Existing services use the repository pattern, but the new `UserService` queries DynamoDB directly." |
| **Complexity** | Cyclomatic complexity, cognitive complexity, deeply nested control flow | "Function `processTask` has cyclomatic complexity 18 (threshold: 10)." |
| **Naming and conventions** | Inconsistent naming, casing, file organization relative to existing code | "`get_data` uses snake_case but the codebase convention is camelCase." |
| **Repo-specific rules** | Custom rules from onboarding config (e.g. "no `any` types", "all API handlers must validate input") | "TypeScript `any` type used in `handler.ts:23` — repo policy requires explicit types." |

**Implementation:** A combination of:
1. **Static analysis tools** — Complexity metrics (e.g. `eslint-plugin-complexity`, `radon`), duplication detection (e.g. `jscpd`), custom lint rules. These run as Lambda-invoked scripts.
2. **LLM-based review** — An LLM (invoked via Bedrock) reviews the diff against the quality dimensions above. The review prompt includes: the diff, the repo's conventions (from onboarding config / system prompt overrides), and a structured output schema. This catches semantic issues that static tools miss (SOLID violations, pattern adherence).

**Output format:** Structured findings:
```typescript
interface QualityFinding {
  tier: 'code-quality';
  severity: 'info' | 'warning' | 'error';    // error = blocking, warning/info = advisory
  rule: string;                                // e.g. "DRY", "SRP", "complexity"
  file: string;
  line?: number;
  message: string;
  suggestion?: string;                         // actionable fix suggestion
}
```

**On failure:** Findings with severity `error` trigger a fix cycle (agent receives the findings and attempts to address them). Findings with severity `warning` or `info` are included in the PR validation report as review comments but do not block finalization. The severity threshold for blocking vs. advisory is configurable per repo in the blueprint config.

### Tier 3 — Risk and blast radius analysis

**What it checks:** The scope, impact, and regression risk of the agent's changes on the broader codebase.

**Analysis dimensions:**

| Dimension | Method | Output |
|---|---|---|
| **Change surface area** | Count files, lines added/removed/modified, modules touched | Quantitative metrics included in the risk report |
| **Dependency graph impact** | Analyze imports/exports, call graphs, and type references to identify downstream consumers of changed code | List of affected modules and their distance from the change |
| **Public API changes** | Detect modifications to exported functions, types, interfaces, class signatures, REST endpoints, or database schemas | Flag breaking vs. non-breaking changes |
| **Shared infrastructure** | Detect changes to shared utilities, base classes, configuration files, CI/CD pipelines, or infrastructure code | Elevated risk flag |
| **Test coverage of affected area** | Cross-reference changed code and its downstream dependents with existing test coverage (if coverage data is available from Tier 1) | Coverage gaps flagged as risk factors |
| **New external dependencies** | Detect additions to `package.json`, `requirements.txt`, `go.mod`, etc. | Flag new dependencies with license, maintenance, and security metadata |

**Implementation:** An LLM-based analysis step that receives:
1. The full diff (`git diff` output)
2. A dependency/import graph of the changed files (generated by a pre-analysis script or extracted during the agent session)
3. The repo's module structure (from onboarding artifacts or a quick `find`/`tree` snapshot)
4. Test coverage data (if available from Tier 1 output)

The LLM produces a structured risk assessment following a defined output schema.

### PR risk level

Every agent-created PR receives a computed **risk level** based on Tier 3 analysis:

| Risk level | Criteria | PR behavior |
|---|---|---|
| **Low** | Small change, no public API changes, high test coverage, no shared infrastructure touched | PR created normally with `risk:low` label |
| **Medium** | Moderate change surface, some downstream dependents, or partial test coverage | PR created with `risk:medium` label and risk summary in validation report |
| **High** | Large change surface, public API changes, shared infrastructure touched, low test coverage of affected area, or new external dependencies | PR created with `risk:high` label, detailed blast radius report, and recommendation for thorough review |
| **Critical** | Breaking API changes, database schema modifications, CI/CD pipeline changes, or security-sensitive code touched | PR created with `risk:critical` label and optional hold for human approval (foundation for HITL approval mode in Iteration 6) |

**Risk level persistence:** The computed risk level is stored in the task record (`risk_level` field) and emitted as a `TaskEvent` (`validation_completed` with risk metadata). This enables:
- Evaluation trending: track risk distribution over time, per repo, per agent prompt version
- Correlation: do high-risk PRs get rejected more often? Do they take longer to review?
- Alerting: notify team leads when a critical-risk PR is created

**Validation report format:** The combined output of all three tiers is posted to the PR as a structured comment (or GitHub Check Run):

```markdown
## Validation Report

### Tier 1 — Tool Validation
- Tests: PASS (42 passed, 0 failed)
- Lint: PASS (0 errors, 2 warnings)
- Type check: PASS

### Tier 2 — Code Quality
- 0 errors, 1 warning, 2 info
- ⚠️ Cognitive complexity of `processTask()` is 14 (threshold: 10)
- ℹ️ Consider extracting shared validation logic (DRY)
- ℹ️ New utility function follows existing naming conventions ✓

### Tier 3 — Risk Assessment
- **Risk level: Medium** 🟡
- Files changed: 4 | Lines: +87 / -12
- Downstream dependents: 3 modules import from changed files
- Public API changes: None
- New dependencies: None
- Test coverage of affected area: 78%
```

### Configuration

Validation tiers are configured per repo in the blueprint config (stored in DynamoDB during onboarding):

```typescript
interface ValidationConfig {
  tier1?: {
    enabled: boolean;                          // default: true
    commands?: string[];                       // override auto-discovered commands
    timeoutSeconds?: number;                   // default: 300
  };
  tier2?: {
    enabled: boolean;                          // default: true
    blockingSeverity: 'error' | 'warning';     // default: 'error'
    customRules?: string[];                    // repo-specific quality rules (from onboarding)
    timeoutSeconds?: number;                   // default: 120
  };
  tier3?: {
    enabled: boolean;                          // default: true
    riskThresholdForHold?: 'high' | 'critical'; // default: 'critical' (future HITL integration)
    timeoutSeconds?: number;                   // default: 120
  };
  maxFixCyclesPerTier?: number;                // default: 2
}
```

### Phasing

- **Iteration 3c (initial):** Tier 1 as orchestrator-driven post-agent step (upgrading from in-session prompt-based validation). Tier 2 and Tier 3 as LLM-based analysis steps. PR risk level labeling and validation report.
- **Iteration 5 (advanced):** Tier 2 enhanced with per-repo learned rules from evaluation and memory feedback loops. Tier 3 enhanced with historical risk correlation (do repos with pattern X produce more rejected PRs?). Risk trending dashboards in the control panel.

## Scope and phasing

- **MVP** — No automated evaluation pipeline. Operators and users inspect task status, PRs, and CloudWatch logs. Improvement is manual.
- **Iteration 3b** — Agent self-feedback after each task. Prompt versioning (store prompt hash with task records). These are lightweight and provide immediate value.
- **Iteration 3c** — Tiered validation pipeline (Tier 1: tool validation, Tier 2: code quality analysis, Tier 3: risk/blast radius analysis). PR risk level computation and labeling. Validation report posted to PRs. Risk level persisted in task records for trending.
- **Iteration 3d** — Review feedback memory loop. PR outcome tracking. Basic evaluation pipeline: failure categorization, memory effectiveness metrics (first-review merge rate, revision cycles, repeated mistakes). Requires new webhook infrastructure.
- **Iteration 5** — Advanced evaluation: ML-based or LLM-based trace analysis (not just rules), A/B prompt comparison framework, automated feedback into prompt templates. Tier 2 enhanced with learned rules from memory. Tier 3 enhanced with historical risk correlation. Risk trending dashboards. AgentCore has a built-in Evaluations service; the platform should evaluate whether it meets these needs before building custom tooling.

## Requirements (future)

- Ingest task lifecycle and, when available, agent traces and logs.
- Support at least: failure categorization, simple success/failure and timeout metrics.
- Write evaluation-derived insights or labels into memory (or a dedicated store) for retrieval during context hydration.
- Capture agent self-feedback at end of each task and persist as searchable insights.
- Track prompt versions per task and support correlation between prompt changes and outcome metrics.
- Optionally drive prompt or template updates from evaluation results (e.g. per-repo or global rules).
- Integrate with observability (same data sources, shared dashboards or alarms).
- Run tiered validation (tool, code quality, risk/blast radius) as post-agent steps and persist results.
- Compute and persist PR risk level (`low` / `medium` / `high` / `critical`) in the task record.
- Post structured validation reports to PRs (comment or Check Run) summarizing all three tiers.
- Track risk level distribution over time per repo, user, and prompt version for trending and correlation.
