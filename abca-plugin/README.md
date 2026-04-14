# ABCA Plugin for Claude Code

A Claude Code plugin that provides guided workflows for setting up, deploying, operating, and troubleshooting the ABCA (Autonomous Background Coding Agents on AWS) platform.

## Installation

```bash
claude --plugin-dir abca-plugin
```

Or add to your project's `.claude/settings.json`:

```json
{
  "plugins": ["./abca-plugin"]
}
```

## What's Included

### Skills (slash commands)

| Skill | Trigger | Description |
|-------|---------|-------------|
| `/setup` | First-time setup, prerequisites | Walk through prerequisites, toolchain, and first deployment |
| `/deploy` | Deploy, diff, destroy | Deploy, diff, or destroy the CDK stack |
| `/onboard-repo` | Add a repository | Onboard a GitHub repo via Blueprint CDK construct |
| `/submit-task` | Submit a coding task | Submit tasks with prompt quality guidance and cost controls |
| `/troubleshoot` | Debug, errors, failures | Diagnose build, deployment, auth, and task execution issues |
| `/abca-status` | Status, health check | Check stack health, running tasks, and recent history |
| `/abca-submit` | Quick submit | Shortcut for rapid task submission |

### Agents

| Agent | Model | Description |
|-------|-------|-------------|
| `cdk-expert` | Sonnet | AWS CDK infrastructure expert for construct design, handler implementation, and stack modifications |
| `agent-debugger` | Sonnet | Read-only debugging specialist for task failures, preflight errors, and CloudWatch log analysis |

### Hooks

- **SessionStart** — Injects ABCA project context (directory structure, key commands, task types, available skills/agents) into every Claude Code session.

## Plugin Structure

```
abca-plugin/
  plugin.json              # Plugin manifest
  agents/
    cdk-expert.md          # CDK infrastructure agent
    agent-debugger.md      # Runtime debugging agent
  hooks/
    hooks.json             # SessionStart context injection
  skills/
    setup/SKILL.md         # First-time setup workflow
    deploy/SKILL.md        # CDK deployment management
    onboard-repo/SKILL.md  # Repository onboarding
    submit-task/SKILL.md   # Task submission workflow
    troubleshoot/SKILL.md  # Troubleshooting guide
    abca-status/SKILL.md   # Platform status checks
    abca-submit/SKILL.md   # Quick task submission
```

## Testing

This plugin is markdown and configuration only (no executable code), so traditional unit tests don't apply. Instead, a **4-layer validation strategy** verifies correctness:

| Layer | What it checks |
|-------|---------------|
| **1. Structural** | `plugin.json` fields, file discovery, JSON/YAML validity, no orphaned files |
| **2. Agent Config** | Frontmatter fields (`model`, `tools`, `description`), valid tool names, file path accuracy, capability alignment with examples |
| **3. Content Integrity** | All repo paths exist, all `mise run` commands are valid tasks, all `bgagent` CLI flags match actual help output, skill cross-references resolve, AWS CLI syntax is correct |
| **4. Hooks** | `hooks.json` structure, supported event names, skills/agents listed in hook content all exist, no sensitive data |

### Running the tests

From the repo root with Claude Code:

```
claude --plugin-dir abca-plugin
```

Then ask Claude to validate the plugin:

```
Validate the abca-plugin using the plugin-validator agent, then verify
all command references and file paths in the skills are accurate.
```

Or run the checks manually:

```bash
# Layer 1: Structural — valid JSON
python3 -c "import json; json.load(open('abca-plugin/plugin.json')); print('plugin.json OK')"
python3 -c "import json; json.load(open('abca-plugin/hooks/hooks.json')); print('hooks.json OK')"

# Layer 3: Content — mise tasks exist
MISE_EXPERIMENTAL=1 mise tasks --all 2>/dev/null | grep -E '(build|install|compile|test|deploy|destroy|diff|synth|bootstrap)'

# Layer 3: Content — CLI flags match
cd cli && node lib/bin/bgagent.js submit --help && node lib/bin/bgagent.js list --help
```

## Development

To modify the plugin:

1. Edit the relevant `.md` file under `skills/`, `agents/`, or `hooks/`
2. Re-validate using the testing strategy above
3. Ensure any new file paths or commands you reference actually exist in the repo
4. Keep the `SessionStart` hook prompt in sync if you add/remove/rename skills or agents
