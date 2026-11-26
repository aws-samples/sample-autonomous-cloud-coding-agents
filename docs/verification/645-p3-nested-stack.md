# Nested MicroVM infrastructure

Nested MicroVM infrastructure is a CloudFormation infrastructure split, not a
virtual machine that runs inside another virtual machine. A fresh nested
deployment and a deployment-specific migration were verified. Reusable migration
commands are a follow-up, not part of this change.

## Resource ownership

`AgentStack` creates the `Microvm` child (`LambdaMicrovmStack`). The child owns
the managed image when one is configured, the build and runtime network
connectors and security groups, the artifact and payload buckets, the logs, and
the build and operator roles.

The execution role remains at `LambdaMicrovmCompute/ExecutionRole` in the parent.
That placement preserves the role's logical ID and avoids a dependency cycle
through the SessionRole trust. The parent `Microvm*` outputs retain the names
that packaging and consumers use. Names derive from the concrete parent
deployment name, not from the child stack token.

## Configuration

| Setting | Behavior |
|---|---|
| `microvm_nested_stack` | Required when MicroVM is enabled. Use `true` for new or already-nested deployments. Retain `false` for existing flat deployments until you complete the reviewed migration. Omission fails synthesis. |
| `microvm_resource_name_prefix` | Supplies distinct names for overlapping nested resources. Preserve it after migration. It does not retain old resources or permissions by itself. |
| `microvm_managed_image_version` | Pins new tasks to an explicitly verified image version. Without a pin, selection follows the latest active version. |
| `microvm_approval_suspend_enabled` | Defaults to `false`. Enable it only after you test the deployed image and coordinator. Disabling new sleep preserves wake and cleanup. |

Nested deployment requires bootstrap bundle **1.9.0** or later. See
[deployment roles](../design/DEPLOYMENT_ROLES.md) and the
[artifact packaging instructions](../../cdk/scripts/README.md).
Build a new image before you switch its runtime pin. Building alone must not
silently change the image that a pinned coordinator uses. Retain a compatible
published coordinator and the exact image version for rollback.

## Existing flat deployments

Before the first upgrade, save `"microvm_nested_stack": false` in the deployment's
CDK context or pass `--context microvm_nested_stack=false` on every deploy.
Omitting the setting fails synthesis. This temporary requirement protects upgrades
that previously omitted the setting. The requirement does not inspect live
resources or perform a migration. New and already-nested installations should
explicitly set `true`. Do not reuse older synthesized assemblies. Regenerate them
with this version.

Do not deploy the nested template directly over a flat deployment. CloudFormation
sees removed parent resources and newly created child resources. Names can
collide, and bucket auto-delete handlers can erase artifacts or pending payloads.

The tested provider rejected native `AWS::Lambda::MicrovmImage` stack refactoring
with an unsupported tag-schema error even though the preview succeeded. Do not
assume from a successful preview that resource import or refactoring is supported.

This checklist is not yet a runnable migration command. The required overlap
migration has these stages:

1. Preserve the exact deployed template and cloud assembly, image and
   published coordinator versions. Capture current resource identities and
   configuration. Keep `microvm_nested_stack=false` on ordinary updates before
   migration.
2. Create the child with distinct names while you retain the old resources and
   their permissions. Build and verify the new image before you switch consumers.
   Reject intermediate templates that exceed CloudFormation's 500-resource limit.
3. Deploy the compatible approval handlers and coordinator before the producers
   of retained requests. Preserve permissions for old workers, including the old
   payload access that P3's new bootstrap deny would otherwise block.
4. Switch consumers with an explicit image pin. Verify normal tasks, approval
   waits, sleep and wake, and rollback while both resource sets are available.
5. Retire old resources only after old workers, Durable executions and uncertain
   starts are accounted for and old tasks are drained. An idle inventory
   snapshot alone is not an admission fence. Preserve any resources that
   published coordinator versions still need.

Setting a concurrency counter to zero is not a reliable pause for asynchronous
producers. A rollback must restore compatible code, image selection and IAM
without deleting pending requests. The reusable tool must enforce
these prerequisites. Track the remaining acceptance in [verification status](./README.md#open-pr-checks).
