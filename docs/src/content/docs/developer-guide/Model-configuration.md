---
title: "Model configuration"
---

**This section is the canonical reference for which model the agent uses and where to change it.** The model ID is configured in five independent layers, in three languages, so read this section before you change a default. A mismatch between the layers fails every task on the stack at turn 0, not only an edge case.

### The five layers

| # | Layer | What it controls | Where | ID form |
|---|---|---|---|---|
| 1 | **IAM invoke allowlist** | Which models the agent's roles may invoke at all, and in which geography. The outer gate. Everything below fails without it. | `DEFAULT_BEDROCK_MODEL_IDS` (`cdk/src/constructs/bedrock-models.ts`). Override with CDK context `bedrockModels`. Geography via context `bedrockGeoRegion` (`global` in the shipped `cdk.json`, `us` if no context is supplied at all) | **Bare** (`anthropic.claude-…`) |
| 2 | **Platform default model** | The model used when nothing narrower is set. Injected by the stack as `ANTHROPIC_MODEL`, derived from `bedrockGeoRegion`. The Python literal is the fallback that a run with no env reaches. | `PLATFORM_DEFAULT_MODEL_ID` (`cdk/src/handlers/shared/bedrock-model-constants.ts`). It is the value that the stack injects, so it is the one to change. Then the no-env fallbacks `agent/src/config.py` and `agent/src/models.py:131` (`TaskConfig.anthropic_model`) | Prefixed (`<geo>.anthropic.…`) |
| 3 | **Auxiliary / fast model** | The small model that Claude Code uses for auxiliary work (WebFetch page summarization, the pre-flight safety check). | Stack env `ANTHROPIC_DEFAULT_HAIKU_MODEL` (`cdk/src/stacks/agent.ts`, the runtime environment block). Agent-side fallback at `agent/src/config.py` | Prefixed (`<geo>.anthropic.…`) |
| 4 | **Per-repo override** | One repository's model, with no agent redeploy. | Blueprint `agent.modelId` (`cdk/src/constructs/blueprint.ts`, `BlueprintProps.agent.modelId`) → RepoTable `model_id` (`cdk/src/handlers/shared/repo-config.ts`) → ECS injects `ANTHROPIC_MODEL` (`cdk/src/handlers/shared/strategies/ecs-strategy.ts`) | Prefixed (`<geo>.anthropic.…`) |
| 5 | **Per-task / local** | One task's model. Payload `model_id` is aliased to `anthropic_model` (`agent/src/pipeline.py`, `_PAYLOAD_KEY_ALIASES`). Local batch runs read `ANTHROPIC_MODEL` from the shell through `agent/run.sh`. | Task payload `model_id`, or shell `ANTHROPIC_MODEL` | Prefixed (`<geo>.anthropic.…`) |

### Environment variables

| Variable | Who sets it | ID form | Purpose |
|---|---|---|---|
| `ANTHROPIC_MODEL` | The ECS strategy, from the repo Blueprint (layer 4). You, in the shell, for local batch runs (layer 5) | Prefixed inference profile | The main coding model. When unset, the `agent/src/config.py` fallback applies. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | The CDK stack, hardcoded at `cdk/src/stacks/agent.ts` (the runtime environment block) | Prefixed inference profile | The small, fast auxiliary model. Must be a granted profile, or the pre-flight check times out with *"Pre-flight check is taking longer than expected"*. |
| `CLAUDE_CODE_USE_BEDROCK` | The CDK stack (`='1'`) and `agent/run.sh` | — | Routes Claude Code to Bedrock instead of the Anthropic API. ABCA always runs on Bedrock. |

### Precedence — narrowest wins

```text
per-task payload model_id            (layer 5)
  > blueprint agent.modelId          (layer 4, arrives as stack env ANTHROPIC_MODEL)
  > stack env ANTHROPIC_MODEL        (layer 3-adjacent / local shell)
  > agent/src/config.py fallback     (layer 2 — global.anthropic.claude-opus-5-5)
```

The **IAM invoke allowlist** (layer 1) gates every one of those, and **account-level Bedrock model access** gates the allowlist. Both gates are silent until invocation. A model that resolves through precedence still fails at turn 0 with `AccessDenied` if it is not in the grant list, and fails again if your account has not completed [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) for it.

### Bare vs. prefixed IDs — the one rule that bites

Layer 1 takes **bare foundation-model IDs**. Every other layer takes the **prefixed inference-profile ID**. This asymmetry is deliberate. Both grant sites derive the inference-profile ARN by *adding* the geo prefix themselves, so a prefixed entry in `bedrockModels` would produce an invalid `us.us.anthropic.…` ARN. The resolver rejects an entry that carries any modelled geo prefix, so the typo fails at synth and not at runtime.

In the other direction, a **bare** ID cannot be invoked on demand at all. Verified:

```console
$ aws bedrock-runtime invoke-model --model-id anthropic.claude-opus-5 ...
ValidationException: Invocation of model ID anthropic.claude-opus-5 with on-demand
throughput isn't supported. Retry your request with the ID or ARN of an inference
profile that contains this model.
```

So the `bedrockModels` context takes `anthropic.claude-opus-5-5`. Every other place takes `global.anthropic.claude-opus-5-5`, or the same ID with the prefix of the geo that you have configured, as the next section describes.

### Choosing the inference-profile geography

The geography that those prefixes name is configurable through the CDK context `bedrockGeoRegion`:

```console
$ cdk deploy -c bedrockGeoRegion=global
```

You can also set it as a `context` entry in `cdk/cdk.json`. The shipped `cdk.json` sets `global`. The code default, when no context is supplied, is `us`. The accepted values are the geographies that `@aws-cdk/aws-bedrock-alpha` models, currently `global`, `us`, `us-gov`, `eu`, `apac`, `jp`, `au`. An unrecognized value **fails at synth**, not at deploy. An invented geography produces a well-formed ARN for a profile that does not exist, so the grant would authorize nothing, and the agent would fail at turn 0 with `AccessDenied` and nothing to explain why.

One value applies to everything that needs a prefix: every grant site (AgentCore runtime, ECS task role, Lambda MicroVM) and both injected env vars, `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`. The single value is deliberate. A deployment can never grant the profiles of one geography while it tells the agent to call the profiles of another.

**Which to choose.** A `global.` profile routes to any supported commercial Region. That routing gives better throughput and resilience under peak demand, which is worth having for tasks that run for hours and burst. A geo profile (`us.`, `eu.`, `apac.`, …) keeps inference within that geography, as a **data-residency requirement** demands. Pick the geo profile in that case. The throughput benefit is not worth a compliance breach.

Check two things when you change the geography. Both fail at runtime, not at synth:

- The models you use must have an active profile in the target geography. Not every model is published to every geo.
- Your account's [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) must cover the deployment Region's entitlements for that geography.

Changing the geography requires a **redeploy**, because the IAM grants are scoped to explicit profile ARNs that are resolved at synth. Switching among models that are already granted does not require a redeploy. See layer 4.

### Bumping the default model

1. Add the **bare** ID to `DEFAULT_BEDROCK_MODEL_IDS` (`cdk/src/handlers/shared/bedrock-model-constants.ts`) and deploy, so that the grant exists before anything tries to use it.
2. Confirm account-level Bedrock access for the model in the target Region.
3. Change `PLATFORM_DEFAULT_MODEL_ID` (`cdk/src/handlers/shared/bedrock-model-constants.ts`). **This step changes what deployed tasks run.** The stack injects the value as `ANTHROPIC_MODEL` on every substrate, so editing only the Python literals of step 4 has no effect on any deployed task.
4. Update the **prefixed** ID in `agent/src/config.py` and `agent/src/models.py` too. These literals are the fallback that a run with no env reaches (a local batch run), and the doc-drift test compares against them.
5. **Verify the SDK price table recognizes the model.** The `max_budget_usd` guardrail is computed from a price table bundled into the Claude Agent SDK at build time, so an unrecognized model silently degrades budget enforcement. Run `agent/scripts/diagnostics/test_sdk_smoke.py` with `ANTHROPIC_MODEL` set to the new ID, divide the reported cost by the input-token count, and confirm the implied rate matches [published Bedrock pricing](https://aws.amazon.com/bedrock/pricing/). A `$0.00` result, or one far from the published rate, means that the table does not know the model and that you cannot trust budgets.
6. The doc-drift test (`cdk/test/contracts/model-default-docs-parity.test.ts`) fails until the documented defaults here and in `agent/README.md` match `config.py`. That failure is your reminder to update both.
7. **Tell operators who override `bedrockModels`.** The override REPLACES the default list, and synth fails ("omits the platform default model") if it lacks either new default. A deployment that carries `-c bedrockModels=[...]` or a `cdk.json` `context` entry must add the new bare IDs before it pulls the bump. Say so in the release notes.

### Cost and model selection

Model choice is a **cost** decision, so you can adjust it per repo and per task without a code change.

**Per-token rate versus token volume.** These figures were measured on the pinned toolchain, with the same one-turn prompt and the same system prompt:

| Model | Input tokens | Reported `cost_usd` | Implied input rate |
|---|---|---|---|
| `us.anthropic.claude-opus-4-8` | 32,145 | $0.160850 | **$5.00/MTok** |
| `us.anthropic.claude-opus-5` | 37,584 | $0.188020 | **$5.00/MTok** |

The token ratio is 1.169 and the cost ratio is 1.169, so the two are identical. **The per-token rate is unchanged. The whole difference is token volume on an identical prompt.** Read the result that way. "Opus 5 costs ~17% more per task" suggests the wrong remedy, which is to switch models. "Same rate, more tokens" names the settings that reduce the cost: prompt size, prompt caching, and `max_turns`.

**Where can I set `max_budget_usd`?**

| Surface | How | Status |
|---|---|---|
| Per task, CLI | `bgagent submit --max-budget <dollars>` (`cli/src/commands/submit.ts`), range 0.01–100 | Works |
| Per task, REST | `max_budget_usd` in the `POST /v1/tasks` body | Works |
| Local batch only | `MAX_BUDGET_USD` shell env, when running `entrypoint.py` directly | Works locally. **Ignored** by the deployed AgentCore **server** mode, which reads the budget from the `/invocations` JSON body |
| Per repo, Blueprint | `agent.maxBudgetUsd` on the repo's `Blueprint` construct | Works. Persisted to `RepoTable.max_budget_usd`. Same `0.01`–`100` range as the CLI, validated at CDK synth so that an out-of-range value cannot deploy. See [Per-repo overrides](/sample-autonomous-cloud-coding-agents/customizing/per-repo-overrides). |
| Platform default | — | None by design. **Unset means unlimited** |

**Per-task runtime budgets are unlimited by default.** Because no platform-wide per-task runtime ceiling applies, the documented mitigation for cost is to choose a lighter-token model, and not to rely only on a cap:

- **Per repo.** Set Blueprint `agent.modelId`. It needs no code change and no agent redeploy. Prefix the ID with the geography that the stack grants, which you read from the stack's `BedrockGeoRegion` output. Synth accepts only the `<geo>.<model>` ID form, with the deployment's geography and a granted model. A bare ID, an ARN, the prefix of another geography, or a model outside the grant list fails synth. For example, a `us.` prefix on a `global` deployment is granted nothing. `bgagent repo onboard --model` refuses the same values.
- **Per task.** Set `model_id` in the task payload.
- **Platform-wide.** Change `PLATFORM_DEFAULT_MODEL_ID` (what every substrate is told to invoke) and the `bedrockModels` context (what every substrate is granted). Change both, or the deploy fails at synth because they disagree.

The model must be in the IAM grant list (layer 1), or the task fails at turn 0 with `AccessDenied`. The grant is the gate, so a lighter model is reachable only if it is granted.

**Trust boundary on the number.** `cost_usd` is the Claude Agent SDK's **client-side estimate** from that bundled price table. It is not authoritative billing. The estimate drifts when Bedrock pricing changes, when the SDK version does not recognize a model, or when discounts and commitments apply. See the warning at line 6 of [Cost attribution](/sample-autonomous-cloud-coding-agents/getting-started/cost-attribution). Authoritative cost comes from AWS Cost Explorer or CUR 2.0.

**Fleet monthly budgets are a separate admission control.** `bgagent budget set --user|--team --monthly-usd <amount> [--hard-stop]` stores a recurring user or Cognito-group limit. Terminal task costs roll up by UTC month from the TaskTable stream. The 80% and 100% crossings publish CloudWatch alarms. Hard-stop scopes reject new task creation at 100% and do not terminate in-flight work. See [Monthly user and team budgets](/sample-autonomous-cloud-coding-agents/customizing/per-repo-overrides#monthly-user-and-team-budgets).