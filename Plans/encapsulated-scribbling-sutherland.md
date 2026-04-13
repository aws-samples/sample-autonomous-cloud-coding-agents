# Plan: Bundle Local Plugin Into a Single Directory

## Context

The local plugin for this project isn't showing up in Claude Code's `/plugin` list. Two issues:
1. Plugin components (`skills/`, `agents/`, `commands/`, `hooks/`) are scattered at the **project root**, separate from the manifest at `.claude-plugin/plugin.json`
2. The plugin isn't registered in `.claude/settings.json` under `enabledPlugins`

The user wants everything consolidated into one directory.

## Approach

Move all plugin component directories into `.claude-plugin/` alongside `plugin.json`, then register the plugin in settings.

### Step 1: Move component directories into `.claude-plugin/`

Move these from project root into `.claude-plugin/`:
- `skills/` → `.claude-plugin/skills/`
- `agents/` → `.claude-plugin/agents/`
- `commands/` → `.claude-plugin/commands/`
- `hooks/` → `.claude-plugin/hooks/`

Resulting structure:
```
.claude-plugin/
├── plugin.json
├── skills/
│   ├── setup/SKILL.md
│   ├── deploy/SKILL.md
│   ├── onboard-repo/SKILL.md
│   ├── submit-task/SKILL.md
│   └── troubleshoot/SKILL.md
├── agents/
│   ├── agent-debugger.md
│   └── cdk-expert.md
├── commands/
│   ├── abca-status.md
│   └── abca-submit.md
└── hooks/
    └── hooks.json
```

### Step 2: Register plugin in `.claude/settings.json`

Add `"abca-getting-started@local": true` to `enabledPlugins`:

```json
{
  "enabledPlugins": {
    "pyright-lsp@claude-plugins-official": true,
    "code-review@claude-plugins-official": true,
    "pr-review-toolkit@claude-plugins-official": true,
    "abca-getting-started@local": true
  }
}
```

### Step 3: Update README.md if it references old paths

Check if the README references the old root-level paths and update accordingly.

## Files to modify
- `.claude/settings.json` — add plugin registration
- `skills/`, `agents/`, `commands/`, `hooks/` — move into `.claude-plugin/`
- `README.md` — update paths if needed

## Verification
1. Restart Claude Code in the project directory
2. Run `/plugin` — the `abca-getting-started` plugin should appear under Project plugins
3. Test a skill trigger (e.g., mention "setup" or "deploy") to confirm components load
