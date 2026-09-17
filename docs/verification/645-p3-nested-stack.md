# ADR-021 nested MicroVM stack

The user requested this split after the P3 approval UX review. The implementation,
local checks and an isolated fresh AWS deployment, image build and deletion are
complete. The normal `backgroundagent-dev` deployment still uses the flat layout;
migration of those existing resources remains open. This infrastructure split
does not nest virtual machines.

## Resource ownership

`AgentStack` creates a `LambdaMicrovmStack` child named `Microvm`. The child owns
the managed image when configured, two network connectors and security groups,
artifact and payload buckets, the log group, and build/operator roles.

The execution role stays at the original parent path
`LambdaMicrovmCompute/ExecutionRole`, beside `AgentSessionRole`. This preserves
its logical ID and avoids a parent/child cycle through session-role trust.
Existing parent `Microvm*` outputs and orchestrator/API consumers refer to child
outputs; packaging and CLI discovery keep their existing output names.

Image, connector and log names derive from the concrete parent deployment name.
Never sanitize the generated child stack name: it is an unresolved token during
synthesis. Child IAM roles have explicit names `<deployment>-MicrovmBuildRole`
and `<deployment>-MicrovmConnectorRole`; names exceeding IAM's 64-character limit
are rejected at synthesis.

## Configuration and bootstrap

For `compute_type=lambda-microvm`, nesting defaults to enabled.
`microvm_nested_stack=false` preserves the existing flat resource paths for
deployments that have not migrated. The setting accepts booleans or the strings
`true` and `false`.

Nested deployments require bootstrap bundle **1.9.0**. It adds only the two exact
child build/operator names to the backend-specific, unconditioned `iam:PassRole`
statement. Legacy role prefixes remain for flat deployments; the runtime
execution role is not added to this statement. Generic nested-stack execution
permissions already existed in bundle 1.7.0.

Bundle 1.9.0 is now installed in account `<account-id>`, `us-west-2`.
CloudFormation completed the reviewed one-policy update on September 17.
The installed policy exactly matches source and the bundle hash is
`dc6301b65558c8fb51200e7b712a754e1b85adda7a512b14ec4f647dc954f541`.
Effective-role simulation without a service condition allows both exact names
and denies the runtime role and a similarly named extra role. Existing parameters
and all other bootstrap resources are unchanged. Evidence is archived under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/bootstrap19`.
Installing this prerequisite does not move the normal stack's resources.

Nesting does not change the 8,192 MiB memory baseline, hook configuration,
runtime HTTPS-only egress, separate build HTTP/HTTPS egress, task-scoped
permissions or sleep gates. The MicroVM/Linear-vault combination remains gated
by #857 until its own deployment verification is complete.

## Existing deployment migration

Do not apply the default nested template directly to an existing flat stack.
CloudFormation sees the old resources removed and child resources added.
The existing image, connector and log names may collide, and the old bucket
auto-delete resources can erase artifacts or pending task payloads.

Keep `microvm_nested_stack=false` in the existing deployment configuration while
preparing a concrete migration:

1. Record the actual templates, physical IDs, image versions, grants and
   retained coordinator versions; preserve the build artifacts.
2. Rehearse the chosen resource-transfer or replacement procedure in an isolated
   deployment, including its rollback. Inspect each change set for deletions,
   replacements, custom-resource effects and named-resource conflicts.
3. Stop new admissions through a procedure that preserves accepted inputs and
   drain active work before switching resource ownership. An idle inventory alone
   does not prevent new tasks from arriving.
4. Deploy bootstrap 1.9.0 and apply only the reviewed migration. Confirm outputs,
   permission boundaries, managed image build and normal task lifecycle.
5. Keep both sleep gates off until the normal activation checks are complete;
   remove temporary migration resources only after verification.

Read-only `GetTemplateSummary` on the normal stack returned identifiers
`ImageArn`/`Name` for `AWS::Lambda::MicrovmImage`, `Arn`/`Name` for
`AWS::Lambda::NetworkConnector`, and `BucketName` for S3. That is useful migration
metadata, not proof that a nested import/refactor will succeed.

[CloudFormation stack refactoring](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stack-refactoring.html)
supports moves between nested stacks. Live `DescribeType` reports both MicroVM
resource types as `FULLY_MUTABLE`, with `Name` their only create-only property.
However, refactoring cannot simultaneously add/delete resources, change their
configuration, or add/change parameters, conditions or mappings. The new explicit
IAM role names and child parameters therefore need staged migration templates;
the final application template is not itself a resource-transfer plan. A successful
refactor preview and rehearsal are still required.

## Verification

The dedicated construct tests exercise bootstrap, imported-image and
managed-image modes, actual parent consumers, session-role trust, stable names,
network separation, backend tags and invalid nesting inputs. Stack tests inspect
both templates and preserve a flat-layout compatibility case. Bootstrap tests
cover the exact new role names, exclusions, generated artifacts and policy hash.

Production `mise //cdk:synth` with managed-image inputs in `us-west-2` succeeded,
including Lambda asset bundling and the production aspects. The corrected output is
under `/tmp/abca-645-nested-20260916/managed-us-west-2`; its manifest explicitly
reports `aws://<account-id>/us-west-2`. This was synthesis, not deployment.

The earlier `managed` assembly actually targeted the profile's `us-east-1` default,
despite the previous version of this record saying `us-west-2`. Setting only
`CDK_DEFAULT_REGION` did not override the CDK CLI's environment selection. The
corrected run explicitly sets `AWS_REGION` and `AWS_DEFAULT_REGION` to `us-west-2`
and checks the generated manifest. Neither synthesis run deployed a nested stack;
the separate live deployment below subsequently exercised `us-west-2`.
AWS `ValidateTemplate` also accepted the MicroVM child, reporting three parameters
and `CAPABILITY_NAMED_IAM`. That API checks template structure; it does not build
the image or validate a migration.

| Template | Resources | File bytes | Parameters | Outputs |
| --- | ---: | ---: | ---: | ---: |
| Parent | 460 | 680,945 | 1 | 49 |
| MicroVM child | 19 | 43,895 | 3 | 8 |
| Existing registry child | 20 | 52,259 | 0 | 2 |
| Existing registry API child | 36 | 64,560 | 3 | 3 |

Every template fits the 500-resource, 1 MiB and 200-parameter/output limits.
The hierarchy totals 535 resources, below the 2,500-resource nested-operation
limit even if every resource changed. Unit synthesis additionally covers
AgentCore, ECS and all three MicroVM image modes, each with the tool gateway
disabled and enabled. It preserves the separate #857 vault guard.

The flat and nested templates retain the execution role logical ID
`LambdaMicrovmComputeExecutionRoleAA0C4A0D`, the same trust document and the same
parent execution-role output reference. The child stack carries the backend tag
so its stack-scoped S3 cleanup helpers inherit it as well.

The first broad test attempt exhausted local disk while staging repeated Docker
source contexts. Generated test directories were cleared. The rerun uses
`CDK_CONTEXT_JSON='{"aws:cdk:disable-asset-staging":true}'` for structural unit
tests; the production synthesis above used actual staging and bundling.

Final local checks:

- CDK suite after the approval work: **232 passed, 2 skipped**;
  **5,126 tests passed, 56 skipped**;
  the snapshot passed.
- The final child-stack tag assertions also passed in a focused **14-test** run.
- TypeScript compilation, ESLint and whitespace checks passed.
- Documentation sync and the **77-page** site build passed.
- Bootstrap golden-baseline, artifact-sync, hash and policy coverage tests passed
  as part of the CDK suite.

Templates, test/build logs, measurements, role-identity comparison and a SHA-256
manifest are archived at
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/nested-us-west-2`.
The older `nested-stack` archive remains historical evidence of the original
structural checks, with its region correction recorded here.

## Fresh nested deployment and cleanup

The isolated stack `backgroundagent-dev-p3-nested-20260917` uses the production
`LambdaMicrovmStack` construct and normal CloudFormation execution role. It
imports the existing VPC and uses separate image/connector names. Its owner tag
is `abca:verification=645-p3-nested-20260917`. No normal resources were moved.

The bootstrap phase created three parent resources and 17 child resources.
The second reviewed change set added only the managed image to the child.
Image `abca-645-nested-probe-20260917:1.0` reached `ACTIVE` / `SUCCESSFUL`;
the stack reached `UPDATE_COMPLETE`.

Verification at `2026-09-17T12:58:18.525Z` confirmed:

- All six lifecycle hooks, the base image, CPU, 8,192 MiB memory and environment
  match normal image 7.0.
- The build uses artifact SHA-256
  `b4bc0c628f4c7976e18850ff47f92e78ecdccec683bc38974e0da82fc8600049`
  from its own tagged artifact bucket.
- The build and connector roles use the exact bootstrap 1.9.0 names.
  The parent execution-role identity is unchanged between phases.
- Both connectors are active in the expected subnets. Runtime egress allows
  port 443; build egress allows 80 and 443; neither security group has ingress.

No worker was launched. After archiving 1,471 image-log events, the owned stack
was deleted. Cleanup verification at `2026-09-17T13:07:47.380Z` confirms absence
of both buckets, connectors, security groups, image/version, roles, provider
function and log groups. The implicitly created provider log group was archived
and removed separately.

The normal deployment retains all 475 physical resource identities, image 7.0,
coordinator alias 10, its disabled live sleep switch and the shared VPC.
Both phases' exact templates, 36 evidence files and a SHA-256 manifest are archived at
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/nested-live`.

This proves fresh nested deployment, image build and deletion. Existing P3 worker
lifecycle evidence remains in its dated records. Moving the existing normal stack
and testing its task path after migration are still required.
