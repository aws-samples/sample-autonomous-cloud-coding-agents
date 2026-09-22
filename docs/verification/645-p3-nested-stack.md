# Nested MicroVM infrastructure

This is a CloudFormation infrastructure split, not a virtual machine running
inside another virtual machine. Fresh nested deployment and a deployment-specific
migration were verified; reusable migration commands remain unfinished.

## Resource ownership

`AgentStack` creates the `Microvm` child (`LambdaMicrovmStack`). It owns the
managed image when configured, build/runtime network connectors and security
groups, artifact/payload buckets, logs, and build/operator roles.

The execution role remains at `LambdaMicrovmCompute/ExecutionRole` in the parent.
This preserves its logical ID and avoids a dependency cycle through SessionRole
trust. Parent `Microvm*` outputs retain the names used by packaging and consumers.
Names derive from the concrete parent deployment name, not the child stack token.

## Configuration

| Setting | Behavior |
|---|---|
| `microvm_nested_stack` | Defaults to `true`. When MicroVM is enabled, omission emits a synthesis warning. Before upgrading an existing flat deployment, set `false` and retain it until completing the reviewed migration. |
| `microvm_resource_name_prefix` | Supplies distinct names for overlapping nested resources; preserve it after migration. It does not retain old resources or permissions by itself. |
| `microvm_managed_image_version` | Pins new tasks to an explicitly verified image version. Without a pin, selection follows the latest active version. |
| `microvm_approval_suspend_enabled` | Defaults to `false`; enable only after testing the deployed image/coordinator. Disabling new sleep preserves wake and cleanup. |

Nested deployment requires bootstrap bundle **1.9.0** or later. See
[deployment roles](../design/DEPLOYMENT_ROLES.md) and the
[artifact packaging instructions](../../cdk/scripts/README.md).
Build a new image before switching its runtime pin; building alone must not
silently change the image used by a pinned coordinator. Retain a compatible
published coordinator and exact image version for rollback.

## Existing flat deployments

Before the first upgrade, save `"microvm_nested_stack": false` in the deployment's
CDK context or pass `--context microvm_nested_stack=false` on every deploy.
Omitting the setting now selects nested infrastructure; it does not detect or
migrate existing flat resources. Keep `false` until the migration below is complete.
The synthesis warning is advisory: it does not inspect the deployed stack or block
deployment. New and already-nested installations can explicitly set `true` to
acknowledge the layout; setting it is not a migration.

Do not deploy the nested template directly over a flat deployment. CloudFormation
sees removed parent resources and newly created child resources; names can collide
and bucket auto-delete handlers can erase artifacts or pending payloads.

The tested provider rejected native `AWS::Lambda::MicrovmImage` stack refactoring
with an unsupported tag-schema error even though the preview succeeded. Do not
assume resource import/refactoring is supported from a successful preview.

The required overlap migration has these stages. This checklist is not yet a
runnable migration command:

1. Preserve the exact deployed template/cloud assembly, image and published
   coordinator versions. Capture current resource identities and configuration.
   Keep `microvm_nested_stack=false` on ordinary updates before migration.
2. Create the child with distinct names while retaining the old resources and
   their permissions. Build and verify the new image before switching consumers.
   Reject intermediate templates that exceed CloudFormation's 500-resource limit.
3. Deploy compatible approval handlers/coordinator before producers of retained
   requests. Preserve permissions for old workers, including the old payload
   access that P3's new bootstrap deny would otherwise block.
4. Switch consumers with an explicit image pin. Verify normal tasks, retained
   approvals, sleep/wake and rollback while both resource sets are available.
5. Retire old resources only after old workers, Durable executions and uncertain
   starts are accounted for and old tasks/leases are drained. An idle inventory
   snapshot alone is not an admission fence. Preserve checkpoint data and any
   resources still needed by published coordinator versions.

Setting a concurrency counter to zero is not a reliable pause for asynchronous
producers. A rollback must restore compatible code, image selection and IAM
without deleting pending requests or saved work. The reusable tool must enforce
these prerequisites; migration template and permission helpers alone do not
constitute that tool. Track remaining acceptance in [verification status](./README.md#open-pr-checks).
