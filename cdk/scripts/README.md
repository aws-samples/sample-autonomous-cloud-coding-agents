# CDK helper scripts

Bundling for Lambda assets is handled at synth time; the **`bundle`** task in **`cdk/mise.toml`** is a no-op placeholder for **`cdk/cdk.json`**. Prefer **`mise //cdk:*`** tasks from the repository root (`MISE_EXPERIMENTAL=1`).

| Script | Purpose | Invoke via |
|--------|---------|------------|
| `generate-bootstrap-artifacts.ts` | Regenerates `cdk/bootstrap/policies/*.json`, `BOOTSTRAP_VERSION`, `BOOTSTRAP_HASH` from the typed policies in `src/bootstrap/policies/` | `mise //cdk:bootstrap:generate` |
| `generate-bootstrap-template.ts` | Regenerates `cdk/bootstrap/bootstrap-template.yaml` (least-privilege CDK bootstrap, `ComputeTypes`-gated compute policies) | `mise //cdk:bootstrap:generate` |
| `package-microvm-artifact.sh` | Packages `agent/` + `contracts/` + `Dockerfile` into the zip artifact an `AWS::Lambda::MicrovmImage` builds from, and uploads it to the CDK-created artifact bucket (ADR-021) | run directly — see the script header for the full bootstrap sequence |
| `preflight-log-delivery.ts` | One-time migration for stacks whose live `AWS::Logs::Delivery*` logical ids predate the CDK library switch in #339 (a `CDKSource`/`CdkLogGroup` segment): deletes exactly those resources so the deploy can recreate them under library naming, instead of rolling back mid-update with `AlreadyExists`. No-op for fresh installs and already-migrated stacks. | runs as the first step of `mise //cdk:deploy`; standalone as `mise //cdk:preflight:log-delivery` (add `-- --check-only` to report without deleting) |

`package-microvm-artifact.sh` exists because CloudFormation cannot produce its own MicroVM `codeArtifact`: the image resource consumes a zip that must already be in S3, and there is no CDK asset type for "zip + Dockerfile a MicroVM image builds from". Everything else on that backend (buckets, roles, network connector, log group, the image resource itself) is CDK-managed in `src/constructs/lambda-microvm-compute.ts`.
