---
title: Troubleshooting
description: Symptom → cause → fix for common ABCA operator and teammate issues.
diataxis: how-to
---

# Troubleshooting

Symptom-first fixes for the most common failures. For interactive diagnosis in Claude Code, use `/troubleshoot` with the ABCA plugin (`claude --plugin-dir docs/abca-plugin`).

## Cognito login / token errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401` on API or CLI | Expired or missing JWT | Run `bgagent configure` again; complete browser login |
| `Invalid grant` during CLI login | Wrong user pool or client ID | Re-run `bgagent configure` with values from stack outputs |
| Token works locally but not in CI | Machine principal not set up | Use API key or OIDC per [Authentication](./USER_GUIDE.md#authentication) |

## `REPO_NOT_FOUND_OR_NO_ACCESS` / GitHub PAT

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Pre-flight `REPO_NOT_FOUND_OR_NO_ACCESS` | PAT cannot read/write repo | Regenerate PAT with `repo` scope; verify org SSO authorization |
| `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` | Read-only token on private repo | Update secret in Secrets Manager; re-run blueprint |
| Wrong org/repo in submit | Typo in `owner/repo` | Match exact GitHub path; repo must be onboarded |

## Task stuck in `QUEUED`

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Task stays `QUEUED` | Per-user concurrency limit | Wait or cancel other tasks; check operator dashboard |
| Never leaves `QUEUED` | Orchestrator or durable workflow issue | Check CloudWatch logs for orchestrator; verify stack healthy |
| Burst of queued tasks | Expected under load | Raise concurrency only after reviewing cost model |

## Webhook signature failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401` on webhook endpoint | HMAC mismatch | Use secret from stack; sign raw body per [Webhook integration](./USER_GUIDE.md#webhook-integration) |
| GitHub delivery shows 4xx | Wrong URL or WAF block | Include `base` path if behind reverse proxy; check API Gateway logs |

## Agent failed / pre-flight errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `GITHUB_UNREACHABLE` | Egress or DNS from VPC | Verify VPC endpoints / DNS firewall per deployment guide |
| `FAILED` shortly after start | Pre-flight or guardrail block | Read `failureReason` on task; see [Task lifecycle](./USER_GUIDE.md#task-lifecycle) |
| `AWAITING_APPROVAL` timeout | Cedar soft-deny gate | `bgagent pending` / `approve` — see [Approval gates](./USER_GUIDE.md#approval-gates-cedar-hitl) |

## Still stuck?

- [Quick Start](./QUICK_START.mdx) — verify deploy and first task
- [Learning path](./LEARNING_PATH.md) — goal-based navigation
- [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) — report platform bugs
