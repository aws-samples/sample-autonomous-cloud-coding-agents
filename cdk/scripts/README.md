# CDK helper scripts

Bundling for Lambda assets is handled at synth time; the **`bundle`** task in **`cdk/mise.toml`** is a no-op placeholder for **`cdk/cdk.json`**. Prefer **`mise //cdk:*`** tasks from the repository root (`MISE_EXPERIMENTAL=1`).

| Script | Purpose | Invoke via |
|--------|---------|------------|
| `generate-bootstrap-artifacts.ts` | Regenerates `cdk/bootstrap/policies/*.json`, `BOOTSTRAP_VERSION`, `BOOTSTRAP_HASH` from the typed policies in `src/bootstrap/policies/` | `mise //cdk:bootstrap:generate` |
| `generate-bootstrap-template.ts` | Regenerates `cdk/bootstrap/bootstrap-template.yaml` (least-privilege CDK bootstrap, `ComputeTypes`-gated compute policies) | `mise //cdk:bootstrap:generate` |
| `package-microvm-artifact.sh` | Packages `agent/` + `contracts/` + `Dockerfile` into the zip artifact an `AWS::Lambda::MicrovmImage` builds from, and uploads it to the CDK-created artifact bucket (ADR-021) | run directly — see the script header for the full bootstrap sequence |
| `build-microvm-artifact.py` | Builds the deterministic zip and digest consumed by the packaging script | Called by `package-microvm-artifact.sh`; `python3 cdk/scripts/build-microvm-artifact.py --help` for local packaging |

`package-microvm-artifact.sh` exists because CloudFormation cannot produce its own MicroVM `codeArtifact`: the image resource consumes a zip that must already be in S3, and there is no CDK asset type for "zip + Dockerfile a MicroVM image builds from". Everything else on that backend (buckets, roles, network connectors, log group, the image resource itself) is CDK-managed by `src/constructs/lambda-microvm-compute.ts`, normally inside `lambda-microvm-stack.ts`.

The default nested layout requires bootstrap bundle 1.9.0. Before upgrading an
existing flat deployment, set and retain `microvm_nested_stack=false` until completing the
[resource migration](../../docs/verification/645-p3-nested-stack.md).
