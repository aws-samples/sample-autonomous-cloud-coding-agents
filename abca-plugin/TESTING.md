# ABCA Plugin — Testing Strategy & Results

> Testing report for the Claude Code plugin at `abca-plugin/`.
> Generated: 2026-04-14

## Testing Strategy

Since this plugin is a **markdown/config-based Claude Code plugin** (no executable code — only SKILL.md files, agent profiles, hooks.json, and plugin.json), traditional unit tests don't apply. Instead, we use a **multi-layer validation approach**:

### Layer 1: Structural Validation
Verify the plugin manifest, file organization, and component discovery.

| Check | Description |
|-------|-------------|
| Manifest validity | `plugin.json` has required fields (`name`, `version`, `description`, `author`) |
| Component discovery | All agents, skills, and hooks are in correct directories |
| No orphaned files | Every file belongs to a recognized plugin component |
| Valid JSON | `plugin.json` and `hooks.json` parse without errors |
| Valid YAML frontmatter | All `.md` components have parseable frontmatter |

### Layer 2: Agent Configuration Validation
Verify agent definitions are well-formed and reference valid resources.

| Check | Description |
|-------|-------------|
| Required frontmatter | Each agent has `model`, `description`, `tools` |
| Valid model values | Model is `opus`, `sonnet`, or `haiku` |
| Valid tool names | All tools are recognized Claude Code tools |
| File path accuracy | Paths in system prompts exist in the repo |
| Capability alignment | Examples match declared tools (e.g., debug agent has no Edit/Write) |

### Layer 3: Content Integrity Verification
Verify that all commands, paths, and cross-references in skill content are accurate.

| Check | Description |
|-------|-------------|
| File path references | All referenced repo paths exist |
| Mise task references | All `mise run` commands map to valid tasks |
| CLI command accuracy | All `bgagent` commands/flags match the actual CLI |
| Skill cross-references | Skills referencing other skills point to ones that exist |
| AWS CLI syntax | AWS CLI commands use valid subcommands |

### Layer 4: Hook Validation
Verify hook configuration is correct and content is accurate.

| Check | Description |
|-------|-------------|
| JSON structure | `hooks.json` has valid structure |
| Event names | Hook events are supported by Claude Code |
| Content accuracy | Skills and agents listed in hook prompt all exist |
| No sensitive data | No credentials or secrets in hook prompts |

---

## Test Results

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
