# Silent-success masking — existing-code baseline

Baseline scan for the custom rules in `silent-success-masking.yaml`
(AI004 / CA-09, [issue #257]). Captured at the rules' introduction;
**40 findings** (15 Python, 25 TypeScript).

[issue #257]: https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/257

The `security:sast:masking` task is **advisory** (it prints findings and
emits SARIF but never fails) until this baseline is triaged. Each finding
must either be fixed (surface the error) or allowlisted with an inline
justified `nosemgrep` comment on the return line:

```
// nosemgrep: ts-silent-success-masking -- <why callers may safely treat this failure as an empty success>
#  nosemgrep: py-silent-success-masking -- <why callers may safely treat this failure as an empty success>
```

Once every finding below is resolved, flip the task to blocking by adding
`--error` to the scan command in the root `mise.toml`
(`tasks."security:sast:masking"`) and delete this file.

Regenerate this list with:

```
semgrep scan --config .semgrep/silent-success-masking.yaml --exclude '.semgrep/*' --quiet .
```

## Baseline findings (2026-06-10, branch point `d912ad2`)

### Python (`py-silent-success-masking`)

| Location | Returned default |
|---|---|
| `agent/src/config.py:108` | `""` |
| `agent/src/config.py:130` | `None` |
| `agent/src/config.py:273` | `None` |
| `agent/src/config.py:312` | `""` |
| `agent/src/hooks.py:1064` | `[]` |
| `agent/src/hooks.py:1078` | `[]` |
| `agent/src/hooks.py:1139` | `[]` |
| `agent/src/hooks.py:1193` | `[]` |
| `agent/src/linear_reactions.py:157` | `None` |
| `agent/src/nudge_reader.py:87` | `None` |
| `agent/src/nudge_reader.py:139` | `[]` |
| `agent/src/pipeline.py:123` | `None` |
| `agent/src/post_hooks.py:375` | `None` |
| `agent/src/telemetry.py:471` | `None` |
| `agent/src/telemetry.py:484` | `None` |

### TypeScript (`ts-silent-success-masking`)

| Location | Returned default |
|---|---|
| `cdk/src/handlers/github-webhook-processor.ts:409` | `null` |
| `cdk/src/handlers/github-webhook-processor.ts:435` | `null` |
| `cdk/src/handlers/shared/context-hydration.ts:427` | `null` |
| `cdk/src/handlers/shared/context-hydration.ts:562` | `[]` |
| `cdk/src/handlers/shared/context-hydration.ts:688` | `null` |
| `cdk/src/handlers/shared/github-comment.ts:323` | `null` |
| `cdk/src/handlers/shared/github-webhook-verify.ts:73` | `null` |
| `cdk/src/handlers/shared/linear-feedback.ts:119` | `null` |
| `cdk/src/handlers/shared/linear-issue-lookup.ts:109` | `null` |
| `cdk/src/handlers/shared/linear-issue-lookup.ts:162` | `null` |
| `cdk/src/handlers/shared/linear-oauth-resolver.ts:269` | `null` |
| `cdk/src/handlers/shared/linear-oauth-resolver.ts:347` | `null` |
| `cdk/src/handlers/shared/linear-oauth-resolver.ts:380` | `null` |
| `cdk/src/handlers/shared/linear-verify.ts:68` | `null` |
| `cdk/src/handlers/shared/memory.ts:289` | `undefined` |
| `cdk/src/handlers/shared/preflight.ts:108` | `undefined` |
| `cdk/src/handlers/shared/slack-verify.ts:64` | `null` |
| `cdk/src/handlers/shared/validation.ts:62` | `null` |
| `cdk/src/handlers/shared/validation.ts:166` | `undefined` |
| `cdk/src/handlers/webhook-create-task.ts:56` | `null` |
| `cli/src/commands/linear.ts:1672` | `null` |
| `cli/src/commands/linear.ts:1797` | `null` |
| `cli/src/commands/linear.ts:1905` | `null` |
| `cli/src/commands/slack.ts:361` | `null` |
| `cli/src/config.ts:74` | `null` |

## Triage notes

Some of these are likely *intentional* degraded-mode fallbacks (e.g. the
webhook signature verifiers return `null` for "not verified", and several
Linear/Slack lookups treat upstream outages as "no data"). Those should get
justified `nosemgrep` allowlist comments rather than rewrites — but each one
needs an explicit decision, which is the point of this gate.
