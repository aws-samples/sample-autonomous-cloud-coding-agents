# ADR-021 repository verification configuration and phase audit

Date: 2026-09-14. Follows the [clean deployment](./645-p2-clean-deployment-20260913.md)
and [first live tasks](./645-p2-live-task-20260914.md). The user selected
`isadeks/vercel-abca-linear` and authorized completing its configuration.

## Configuration

The selected repository has npm lint/test scripts but no mise tasks. All three
compute backends use the same worker defaults (`mise run build` and
`mise run lint`), and all accept per-repository command overrides.

The operator CLI now exposes those existing settings:

```bash
bgagent repo onboard isadeks/vercel-abca-linear \
  --region us-west-2 --stack-name backgroundagent-dev \
  --compute-type lambda-microvm \
  --build-command 'npm ci && npm test' \
  --lint-command 'npm run lint'
```

This command was executed against account `<account-id>`. A separate
`repo show` confirmed both effective commands and `lambda-microvm` routing.
The east deployment was not changed. No infrastructure or image update is
required: the deployed coordinator already forwards these fields to the worker.
The build command installs the pinned dependencies before running tests, so the
following lint command has its tools available.

The CLI also preserves existing commands on re-onboarding and displays their
effective values. Previously, its replacement row silently omitted both fields.
Two regressions failed before the preservation fix. Tests now cover active and
removed repositories, backend changes, explicit overrides, empty-string resets,
fresh defaults, command parsing and text/JSON display. CLI compile/lint and all
**62 suites / 938 tests** pass. The implementation is commit `62cce37d`.

For a repository managed through CDK, put the same values in
`Blueprint.pipeline.buildCommand` / `lintCommand`; CLI changes alone do not edit
that source. This test repository was onboarded through the operator CLI.

## Local mise alternative

A local checkout of PR #584 contains commit `7bf72d3`, adding `mise.toml` and
updating README. The tasks share an `install` dependency (`npm ci`); `build`
runs `npm test`, and `lint` runs `npm run lint`. `mise run build ::: lint`
passed, including the repository's one baseline test. It does not compile site
assets or establish functional application coverage.

Code Defender rejected the push because it considers the public repository
unapproved. The hook was not bypassed and the commit was not published through
another channel. PR #584 remains at its previously published README-only head.
The live RepoTable configuration above works independently of that local file.

`npm ci` reported nine existing dependency vulnerabilities (three moderate,
five high and one critical). Dependencies and the lockfile were not changed by
this configuration work; successful lint/tests are not a security audit.

## Live verification

An initial PR-review attempt, `01M2G0SN8CN8H2WJBK70S5GC60`, failed during hydration
because Bedrock Guardrails classified its PR context as
`CONTENT/PROMPT_ATTACK (MEDIUM)`. It had no session ID and launched no MicroVM.
No guardrail settings were changed. This is not runtime verification. The
platform's notification handler nevertheless posted a failed-task status comment
to PR #584 before agent execution; a read-only agent instruction does not disable
those platform notifications. The PR's source head remains
`fd509fa63fa089df356574bdd654123c8621b12e`.

A separate default-branch inspection, `01M2G0VC4TY37SJ7GGE2JQ7YXF`, was submitted
at 13:14:06 UTC with a 12-turn / $2 limit. The request keeps files and GitHub
records unchanged. It launched
`microvm-f858bc9f-1235-3052-9792-2d9b263cd33b` using managed image `1.0`.
Live logs already confirm the automatic pre-agent build and lint commands
returned `OK` at 13:14:22 UTC. Automatic post-agent build and lint also returned
`OK` at 13:15:56 UTC. These are the platform's own four verification invocations,
not just commands the model chose to run. The task stored `build_passed=true`
and `lint_passed=true`.

The overall task ended **FAILED** at 13:15:58 UTC: `coding/new-task-v1` requires a
commit/PR, and the inspection intentionally produced neither. Its error records
`agent_status=success, deliverable=lost`. This is evidence that configuration
works and a worker-reported failure is finalized, **not** another successful
coding/PR smoke test. The earlier successful coding/PR tests remain the evidence
for that path. Reported model cost was $0.14489115 and duration 95.1 seconds.

Cleanup was verified independently:

- Service state `TERMINATED`; no active MicroVMs remained in the region.
- `/terminate` returned 200 at 13:16:09 UTC with zero active pipeline threads.
- The task's payload prefix was empty.
- The task-owned reservation was `released` at 13:16:09.292 UTC, and the
  temporary user's strongly read counter was zero.
- The temporary Cognito user was deleted after checking its recorded subject ID;
  a follow-up read returned `UserNotFoundException` at 13:17:11 UTC. The isolated
  cached credentials were removed.

This failure-path observation does not cover a crashed worker, rejected run hook,
lost start reply, or failed cleanup API. Those need their own cases.

## P2/P3 completion audit

| Area | Current evidence | Remaining work |
|---|---|---|
| P1 start/poll/stop | Merged; exercised again by the clean deployment | Keep service-fact limits in the original runbook explicit |
| P2 managed build and normal work | Clean bootstrap/image deployment; coding, PR iteration, Memory writes, live logs, cancellation and a worker-reported failure cleanup observed | Complete failure/recovery and effective permission/network matrix |
| Repository command configuration | CLI configured and independently read back; all four automatic pre/post commands pass live; cleanup verified | Local mise file remains unpublished; CLI source still needs upstream review/merge |
| #817 review fixes | Error classification, deletion grants, trusted configuration, malformed-byte handling and comment fixes on takeover branch | Effective-role and ingress negatives; upstream review/merge |
| #700 task-scoped payloads | v2 signed references and deployment manifests implemented; real launches work | Cross-task/public-object denials, expiry, conditional-write and coordinated migration cases |
| #818 registry portability | Large-payload transport/local loader tests; shared HTTPS/443 limits documented | Real remote-tool DNS/TLS/auth/connectivity |
| #841 thread isolation | Regression and Python suite passed | Upstream merge and requested downstream #680 build confirmation |
| #810 logging diagnostics | Unused counter removed; structured failure events tested; normal live logs work | Do not equate normal log delivery with injected live writer-failure evidence |
| Start/capacity/metadata protocols | Local race/replay tests; normal live reservation release and cancellation work | AWS replay/token semantics, unknown-start recovery, effective session permissions, migration/drain and scan-scale checks |
| Managed image updates | First image build succeeded | Make code-only artifact changes trigger a managed-image rebuild and verify it |
| Optional nesting / #857 | Offline prototype only; clean deployment uses current root layout | Production split and full feature/migration validation if adopted |
| P3 sleep/wake | Strategy methods, persistent intent, policy helper and original-deadline handling implemented | Guest hooks, credential/durability barriers, bounded coordinator recovery, approval wiring, scoped grants, compatible-image control and live lifecycle matrix |

All seven inspected upstream issues (#645, #817, #700, #818, #841, #857 and #810)
remain open. A local fix or one positive AWS run does not establish upstream
completion. ADR-021 defines P1–P3; it has no P4.

The ordered [P3 implementation plan](./645-p3-implementation-plan.md) remains the
working checklist. Automatic suspension remains disabled. P3 is not complete.

## Evidence

Private evidence is retained under `/tmp/abca-645-p2-clean-20260913/`, including
CLI/docs build logs, redacted configuration output, task requests and timestamped
AWS/task/log observations. `config-command-execution-evidence.json` contains the
four commands and their successful completion lines; `config-final-*.json` and
`config-verification-user-cleanup.json` record cleanup. The documentation sync
and **77-page** site build also passed.
