# Deployment profile parity vectors

Shared test cases for the deployment profile (`abca.deployment.json`,
[ADR-024](../../docs/decisions/ADR-024-deployment-profiles.md)). CDK synthesis
reads and validates the profile; `bgagent setup` reads and writes it. The CLI
cannot import the CDK package, so each rule below exists twice:

| Rule | CDK | CLI |
|------|-----|-----|
| Profile validation (`parseDeploymentProfile`) and the feature list (`DEPLOYMENT_FEATURES`) | [`cdk/src/deployment/features.ts`](../../cdk/src/deployment/features.ts) | [`cli/src/deployment-profile.ts`](../../cli/src/deployment-profile.ts) |
| Per-feature context switches (`FEATURE_CONTEXT_KEYS`) | `cdk/src/deployment/features.ts` | [`cli/src/commands/setup.ts`](../../cli/src/commands/setup.ts) |
| Profile file of a stack (`deploymentProfileCandidates`, with the default stack name and the stack-name pattern) | `cdk/src/deployment/features.ts` | `cli/src/deployment-profile.ts` |

Both Jest suites run every case in this directory against their own copy. A
copy that changes alone fails its own run; once the case is updated to match,
the other package's run fails until its copy follows. Without that, the wizard
could write a profile that synthesis rejects, or look for a stack's profile in
a file synthesis does not read.

## Why this lives in `contracts/`

Neither `cdk/` nor `cli/` owns the profile format: it is an agreement between
them, kept where both test suites reach it.
[`contracts/cedar-parity/`](../cedar-parity/README.md) and
[`contracts/registry-resolution/`](../registry-resolution/README.md) work the
same way.

## Consumers

- **CDK:** [`cdk/test/deployment/deployment-profile-vectors.test.ts`](../../cdk/test/deployment/deployment-profile-vectors.test.ts)
- **CLI:** [`cli/test/deployment-profile-vectors.test.ts`](../../cli/test/deployment-profile-vectors.test.ts)

## Files

Each file is one object with a `description` and a `cases` array. A case's
`name` is its test name in both suites: keep it unique within the file.

### `parse.json`

A profile, and what parsing it gives.

```json
{
  "name": "features-as-array",
  "profile": { "schemaVersion": 1, "features": [] },
  "expected": { "error": "features must be an object" }
}
```

- `profile`: the parsed content of the file, any JSON value.
- `expected.profile`: what `parseDeploymentProfile` returns: `features`, and
  `compute` when the profile has it.
- `expected.error`: the detail of the failure. Both parsers must throw exactly
  `Invalid deployment profile <source>: <expected.error>`; in the CLI the error
  is a `CliError`.

The message of the `unknown-feature` case quotes the whole feature list, in
order. Together with the rule that a profile names every feature, that holds
the two lists to each other: a feature added to one copy alone fails these
cases.

The two `-reported-before-` cases break two rules at once: both parsers must
report the same one.

### `context.json`

The selection of a profile plus CDK context, and the selection synthesis
deploys.

```json
{
  "name": "enableSlack-turns-slack-off",
  "features": { "slack": true, "linear": false, "jira": false, "deployPreviewScreenshots": false, "agentRegistry": false, "toolGateway": false },
  "context": { "enableSlack": false },
  "expected": { "features": { "slack": false, "linear": false, "jira": false, "deployPreviewScreenshots": false, "agentRegistry": false, "toolGateway": false }, "conflicts": ["enableSlack"] }
}
```

- **CDK** (`resolveDeploymentFeatures`): returns `expected.features`, or throws
  exactly `expected.error`. A context switch wins over the profile.
- **CLI** (`conflictingContextOverrides`): the CLI resolves no selection of its
  own. Before it deploys, `bgagent setup` refuses persistent CDK context that
  would override the selection the operator confirmed. The runner writes
  `context` to `cdk/cdk.context.json` of a temporary checkout and expects one
  conflict for each key in `expected.conflicts`, in that order.
- `expected.conflicts`: the switches that make synthesis differ from the
  profile: one that changes a feature, and a malformed one, which fails
  synthesis. For a case that expects a selection, the CDK runner checks that
  these are exactly the switches of the features that changed. It also fails
  unless every switch is listed by at least one such case.

### `profile-files.json`

A stack name, and the profile file names `deploymentProfileCandidates` returns:
`abca.deployment.json` for the default stack (`backgroundagent-dev`) and for a
name that is not a valid stack name, `abca.deployment.<stackName>.json` for any
other. Valid names sit next to names just outside the rule (one character too
long, a leading digit or hyphen, an underscore), so a bound or character class
that changes in one copy fails a case.

## Not covered here

- **The list of compute backends as a whole.** The cases pin the three names
  and the rejection of others, but a backend added to one copy alone passes
  them: CDK declares a type, which a test cannot enumerate.
  [`cli/test/deployment-capabilities-parity.test.ts`](../../cli/test/deployment-capabilities-parity.test.ts)
  compares the two declarations.
- **The regional capability catalog**
  ([`contracts/deployment-capabilities.json`](../deployment-capabilities.json))
  **and the bootstrap version.** The same parity test holds them.
- **What only one copy starts to accept.** The cases are examples of what is
  accepted and what is rejected today. When one copy alone starts to accept
  something new, such as another top-level key or a profile that leaves out a
  feature key, all the cases still pass until one of them uses it.
- **Rules that only one side has.** How each side finds and reads the file,
  and the Linear vault check (CDK). Each package tests its own.
- **Agreements these cases do not pin.**
  - Region availability: `capabilityViolations` in
    `cdk/src/deployment/capabilities.ts` and `isAvailableIn` in
    `cli/src/deployment-capabilities.ts` are separate code over the same
    catalog data.
  - The context keys `compute_types`, `compute_type` and `deploymentProfile`:
    at synthesis they take precedence over the profile, and the CLI's conflict
    check relies on those names and on that precedence.
  - A switch value given as a one-element array (`["true"]`): the CLI compares
    it as `true`, synthesis rejects it. The two sides differ here, so no case
    covers it.

## Updating

1. **A new feature.** Besides the code (the root
   [`AGENTS.md`](../../AGENTS.md) names the files in its "Deployment profiles"
   row): add the key to every `features` object here, add the name to the
   message of `unknown-feature`, and add a case to `context.json` in which its
   switch turns the feature off.
2. **A changed rule or message.** Change both copies and the case in one
   commit. A changed bound or character class of the stack-name rule needs a
   case on each side of the new boundary. A rule that starts to accept
   something new needs a new case that uses it: that case is what fails the
   other package's run.
3. **A new case.** Add it to the file of its kind, next to the cases it
   belongs with; both runners pick it up.
