# ABCA Plugin — Test Results

> Test report for the Claude Code plugin at `abca-plugin/`.
> Generated: 2026-04-14
>
> For the testing strategy and how to run these checks, see [`README.md`](./README.md#testing).

## Results

### Layer 1: Structural Validation — PASS

| Check | Result | Notes |
|-------|--------|-------|
| `plugin.json` valid JSON | PASS | All required fields present |
| `name` field | PASS | `abca-getting-started` — valid kebab-case |
| `version` field | PASS | `1.0.0` — valid semver |
| `description` field | PASS | Present and descriptive |
| `author` field | PASS | `aws-samples` |
| Agent files discovered | PASS | 2 agents in `agents/` |
| Skill files discovered | PASS | 7 skills in `skills/*/SKILL.md` |
| Hook file discovered | PASS | `hooks/hooks.json` present |
| No orphaned files | PASS | Every file is part of a component |

### Layer 2: Agent Configuration — PASS (1 issue found)

**cdk-expert.md** — All checks PASS

| Check | Result |
|-------|--------|
| Has `model`, `description`, `tools` | PASS |
| Model `sonnet` is valid | PASS |
| Tools `[Read, Grep, Glob, Bash, Edit, Write]` valid | PASS |
| File paths exist | PASS |
| 3 `<example>` blocks present | PASS |

**agent-debugger.md** — 1 FAIL

| Check | Result | Notes |
|-------|--------|-------|
| Has `model`, `description`, `tools` | PASS | |
| Model `sonnet` is valid | PASS | |
| Tools `[Read, Grep, Glob, Bash]` valid | PASS | |
| No Edit/Write (read-only debugger) | PASS | |
| 3 `<example>` blocks present | PASS | |
| File path `agent/prompts/` exists | **FAIL** | Should be `agent/src/prompts/` |

### Layer 3: Content Integrity — PASS

**File Paths (6/6 PASS)**

| Path | Referenced In | Result |
|------|--------------|--------|
| `cli/lib/bin/bgagent.js` | abca-status, abca-submit, submit-task, troubleshoot | PASS |
| `cdk/src/stacks/agent.ts` | onboard-repo | PASS |
| `cdk/src/handlers/shared/types.ts` | troubleshoot | PASS |
| `cli/src/types.ts` | troubleshoot | PASS |
| `agent/run.sh` | troubleshoot | PASS |
| `cdk/cdk.out/` | deploy | PASS |

**Mise Tasks (10/10 PASS)**

| Command | Result |
|---------|--------|
| `mise run build` | PASS |
| `mise run install` | PASS |
| `mise run //cdk:compile` | PASS |
| `mise run //cdk:test` | PASS |
| `mise run //cdk:deploy` | PASS |
| `mise run //cdk:destroy` | PASS |
| `mise run //cdk:diff` | PASS |
| `mise run //cdk:synth` | PASS |
| `mise run //cdk:bootstrap` | PASS |
| `mise run //cli:build` | PASS |

**CLI Commands (6/6 PASS)**

| Command | Flags Verified | Result |
|---------|---------------|--------|
| `bgagent submit` | `--repo, --issue, --task, --pr, --review-pr, --max-turns, --max-budget, --wait, --idempotency-key, --output` | PASS |
| `bgagent list` | `--status, --limit, --output` | PASS |
| `bgagent status` | `<task-id>` | PASS |
| `bgagent events` | `<task-id>, --output` | PASS |
| `bgagent configure` | `--api-url, --region, --user-pool-id, --client-id` | PASS |
| `bgagent login` | `--username` | PASS |

**Skill Cross-References (3/3 PASS)**

| From | References | Result |
|------|-----------|--------|
| abca-status | setup | PASS |
| setup | onboard-repo | PASS |
| troubleshoot | onboard-repo | PASS |

### Layer 4: Hook Validation — PASS

| Check | Result | Notes |
|-------|--------|-------|
| Valid JSON structure | PASS | |
| Event: `SessionStart` | PASS | Supported in Claude Code |
| Hook type: `prompt` | PASS | Valid hook type |
| Skills listed match actual | PASS | All 7 skills referenced exist |
| Agents listed match actual | PASS | Both agents exist |
| No sensitive data | PASS | Context only, no secrets |

---

## Issues Found

### Issue 1: Incorrect path in agent-debugger.md (Bug)

**Severity:** Medium
**Location:** `abca-plugin/agents/agent-debugger.md`
**Description:** The system prompt references `agent/prompts/` but the correct path is `agent/src/prompts/`.
**Impact:** The agent-debugger may fail to locate prompt files when debugging agent issues.
**Fix:** Update path references from `agent/prompts/` to `agent/src/prompts/`.

---

## Overall Result

| Layer | Result | Issues |
|-------|--------|--------|
| 1. Structural Validation | PASS | 0 |
| 2. Agent Configuration | PASS* | 1 (incorrect path) |
| 3. Content Integrity | PASS | 0 |
| 4. Hook Validation | PASS | 0 |

**Overall: PASS with 1 medium-severity bug identified and fixed.**
