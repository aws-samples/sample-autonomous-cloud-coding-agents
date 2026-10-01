# CDK helper scripts

Bundling for Lambda assets is handled at synth time; the **`bundle`** task in **`cdk/mise.toml`** is a no-op placeholder for **`cdk/cdk.json`**. Prefer **`mise //cdk:*`** tasks from the repository root (`MISE_EXPERIMENTAL=1`).

| Script | Purpose | Invoke via |
|--------|---------|------------|
| `generate-bootstrap-artifacts.ts` | Regenerates `cdk/bootstrap/policies/*.json`, `BOOTSTRAP_VERSION`, `BOOTSTRAP_HASH` from the typed policies in `src/bootstrap/policies/` | `mise //cdk:bootstrap:generate` |
| `generate-bootstrap-template.ts` | Regenerates `cdk/bootstrap/bootstrap-template.yaml` (least-privilege CDK bootstrap, `ComputeTypes`-gated compute policies) | `mise //cdk:bootstrap:generate` |
| `package-microvm-artifact.sh` | Packages `agent/` + `contracts/` + `Dockerfile` into the zip artifact an `AWS::Lambda::MicrovmImage` builds from, and uploads it to the CDK-created artifact bucket (ADR-021) | run directly — see the script header for the full bootstrap sequence |
| `ua-wire-check.ts` | Manual, credentialed diagnostic (#319/#345): imports the real `src/handlers/shared/ua.ts` helper and prints the assembled outbound `User-Agent` on real SDK v3 calls, proving both the SDK-native `app/` and helper-supplied `md/` segments reach the wire (CloudTrail is unavailable — DynamoDB data events are blocked) | `npx tsx scripts/ua-wire-check.ts` — see `docs/verification/ua-wire-check-runbook.md` |

`ua-wire-check.ts` is a hand-run verification tool, not a CI test: it needs live AWS credentials and makes real (read-only) API calls. Its Python counterpart is `agent/scripts/diagnostics/ua_wire_check.py`. Neither is in the `cdk`/`agent` lint, type-check, or dead-code scopes (those cover `src`/`test`) — matching the other helper scripts here.

`package-microvm-artifact.sh` exists because CloudFormation cannot produce its own MicroVM `codeArtifact`: the image resource consumes a zip that must already be in S3, and there is no CDK asset type for "zip + Dockerfile a MicroVM image builds from". Everything else on that backend (buckets, roles, network connector, log group, the image resource itself) is CDK-managed in `src/constructs/lambda-microvm-compute.ts`.
