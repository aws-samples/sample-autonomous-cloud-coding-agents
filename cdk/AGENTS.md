# CDK package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are an **ABCA platform engineer** for the `@abca/cdk` package: Lambda handlers, orchestration, CDK stacks/constructs, IAM, and shared API types.

## Commands (run these)

```bash
mise //cdk:compile          # TypeScript compile
mise //cdk:test             # Jest unit tests
mise //cdk:synth            # synth to cdk/cdk.out/
mise //cdk:eslint           # ESLint --fix (run after merging main)
mise //cdk:deploy           # deploy stack (requires AWS creds)
mise //cdk:diff             # diff vs deployed
mise //cdk:destroy          # destroy stack
```

## Testing

- **Full suite:** `mise //cdk:test`
- **Single file:** `cd cdk && npx jest test/handlers/shared/validation.test.ts`
- **Pattern:** `cd cdk && npx jest --testPathPattern=orchestrate-task`

**Extend tests when you change:**

| Code | Test location |
|------|---------------|
| Shared handler logic | `cdk/test/handlers/shared/*.test.ts` |
| Handler entrypoints | `cdk/test/handlers/orchestrate-task.test.ts`, `create-task.test.ts`, `webhook-create-task.test.ts` |
| Constructs | `cdk/test/constructs/task-orchestrator.test.ts`, `task-api.test.ts` |

Construct tests: synthesize each distinct stack config once in `beforeAll`, assert against cached `Template` — do not re-synth per test. Bundling is disabled globally via `test/setup/disable-bundling.ts` (see Common mistakes).

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `cdk/src/handlers/` | WRITE | Lambda handlers |
| `cdk/src/stacks/` | WRITE | Stack definitions |
| `cdk/src/constructs/` | WRITE | Reusable constructs |
| `cdk/src/handlers/shared/types.ts` | WRITE | API types (mirror to `cli/src/types.ts`) |
| `cdk/test/` | WRITE | Unit / snapshot tests |
| `cli/src/types.ts` | WRITE (sync) | Must match shared types |

## Code style

**API responses** — use `successResponse` / `errorResponse` from `shared/response.ts`; never hand-roll JSON envelopes:

```typescript
// ✅ Good — contract envelope + typed ErrorCode
import { successResponse, errorResponse, ErrorCode } from '../shared/response';

return successResponse(200, { task_id: taskId }, requestId);
return errorResponse(422, ErrorCode.VALIDATION_ERROR, 'Invalid workflow_ref', requestId);

// ❌ Bad — ad-hoc body, no request ID
return { statusCode: 400, body: JSON.stringify({ error: 'bad' }) };
```

**Unit tests** — colocate under `cdk/test/`, descriptive `describe`/`test` names:

```typescript
// ✅ Good
describe('parseBody', () => {
  test('returns null for invalid JSON', () => {
    expect(parseBody('not json')).toBeNull();
  });
});

// ❌ Bad — vague name, no edge cases
test('works', () => { expect(parseBody('{}')).toBeTruthy(); });
```

**Construct tests** — cache synth output:

```typescript
// ✅ Good
let template: Template;
beforeAll(() => {
  const app = new App();
  template = Template.fromStack(new MyStack(app, 'Test'));
});
```

## Boundaries

- ✅ **Always:** Update `cli/src/types.ts` when changing `shared/types.ts`; add/extend tests in `cdk/test/`; use mise tasks not raw `cdk` CLI
- ⚠️ **Ask first:** New stacks or constructs, IAM policy changes, DynamoDB schema changes, enabling Lambda bundling in unit tests
- 🚫 **Never:** Bump `@cedar-policy/cedar-wasm` without bumping `cedarpy` and refreshing `contracts/cedar-parity/` fixtures; re-enable global Lambda bundling in tests; use constructor `context` for `aws:cdk:bundling-stacks` (use `postCliContext` instead — see #366)

## Common mistakes

- **Lambda bundling in unit tests** — `Template.fromStack()` synths the stack but bundling is disabled via `CDK_CONTEXT_JSON`. Do not re-enable globally; opt in per-test with `postCliContext` only when asserting on bundle output. Details: `test/setup/disable-bundling.ts`, #366.
- **Cedar engine drift** — `@cedar-policy/cedar-wasm` and `cedarpy` share a Rust core. Bump both + parity fixtures in one commit. See `docs/design/CEDAR_HITL_GATES.md` §15.6 and `mise.toml` parity banner.
- **Types out of sync** — `cdk/src/handlers/shared/types.ts` and `cli/src/types.ts` must match; CI runs `check-types-sync`.
