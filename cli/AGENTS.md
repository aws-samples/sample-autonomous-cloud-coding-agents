# CLI package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You maintain the **`bgagent` CLI** (`@backgroundagent/cli`): Commander commands, Cognito auth, HTTP client, and API types mirrored from CDK.

## Commands (run these)

```bash
mise //cli:build            # compile + type-check + test + lint
mise //cli:typecheck        # type-check src and test (jest does not check types)
cd cli && mise run test     # Jest only
cd cli && mise run compile  # tsc only
mise //cli:eslint           # ESLint --fix (run after merging main)
mise //cli:eslint:check     # ESLint without --fix: reports only; a warning fails too
```

## Testing

- **Full suite:** `cd cli && mise run test` or `mise //cli:build`. The coverage floors apply; they count every file in `src/`, tested or not.
- **Single file:** `cd cli && npx jest --coverage=false test/commands/status.test.ts`
- **Pattern:** `cd cli && npx jest --coverage=false --testPathPatterns=auth`
- **Types:** `mise //cli:typecheck`. Jest only transpiles the tests (ts-jest), so this task is what type-checks `test/`; the build runs it. A fixture has to match the type from `src/types.ts` it is declared with.

Without `--coverage=false` a partial run fails on the coverage floors after its tests pass.

Mock `ApiClient` in command tests; reset `process.exitCode` in `beforeEach`/`afterEach` (commands set exit codes — see `status.test.ts`).

The suite is sealed off from the machine it runs on (`test/setup/`):

- **No home, no AWS identity** — `HOME` is an empty scratch directory and every `AWS_*` and `BGAGENT_*` variable is removed before the first test, so no test sees `~/.bgagent`, `~/.aws` or `~/.cdk.json`. A test that needs a config creates a directory and points `BGAGENT_CONFIG_DIR` at it (see `test/config.test.ts`).
- **No network** — a connection to anything but loopback throws `cli tests must not open network connections…`. Mock the client or `fetch` call that sends the request; do not add hosts to the list.
- **Snapshots** — the suite runs with `--ci`, which fails on a missing or changed snapshot instead of writing it. To add or update one on purpose: `npx jest --coverage=false -u <file>`, then commit the snapshot.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `cli/src/bin/bgagent.ts` | WRITE | Commander entry point |
| `cli/src/commands/` | WRITE | One file per subcommand |
| `cli/src/api-client.ts` | WRITE | Authenticated `fetch` wrapper |
| `cli/src/auth.ts` | WRITE | Cognito login, token cache (`~/.bgagent/credentials.json`) |
| `cli/src/types.ts` | WRITE | API types (mirror of `cdk/.../types.ts`) |
| `cli/test/` | WRITE | Jest tests |

## Code style

**New command** — factory function + `Command` from commander; throw `CliError` for user-facing errors:

```typescript
// ✅ Good — factory, validated options, CliError
import { Command } from 'commander';
import { CliError } from '../errors';

export function makeStatusCommand(): Command {
  return new Command('status')
    .argument('<task-id>', 'Task ID')
    .option('--output <format>', 'text or json', 'text')
    .action(async (taskId: string, opts) => {
      if (!taskId) throw new CliError('Task ID is required.');
      // ...
    });
}

// ❌ Bad — side effects at import, console.error + process.exit
export const status = new Command('status').action(() => {
  console.error('failed'); process.exit(1);
});
```

**Command tests** — mock `ApiClient`, spy `console.log`:

```typescript
// ✅ Good
jest.mock('../../src/api-client');
beforeEach(() => { process.exitCode = undefined; });

test('renders snapshot from combined payload', async () => {
  mockGetStatusSnapshot.mockResolvedValue({ task: { task_id: 'abc', status: 'RUNNING', ... } });
  await program.parseAsync(['node', 'status', 'abc']);
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RUNNING'));
});
```

**Conventions:** `no-console` ESLint rule is disabled in CLI source (console output is the product). API URL from stack output includes `/v1/` — append only resource paths (`/tasks`, `/tasks/{id}`).

## Boundaries

- ✅ **Always:** Add tests in `cli/test/` for new commands; keep `types.ts` in sync with CDK; use `CliError` / `ApiError` for failures
- ⚠️ **Ask first:** New runtime dependencies, changes to auth/token storage format
- 🚫 **Never:** Change `cli/src/types.ts` without updating `cdk/src/handlers/shared/types.ts`; hardcode API URLs with stage prefix duplicated

## Common mistakes

- **Coverage-ignore comment** — ESLint (`no-warning-comments`) rejects a comment that contains `istanbul ignore`, `c8 ignore`, `v8 ignore` or `node:coverage`, in `src/` and `test/`: such a comment takes code out of what the coverage floors measure. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **API type drift** — Update both `cli/src/types.ts` and `cdk/src/handlers/shared/types.ts` in the same PR. See [cdk/AGENTS.md](../cdk/AGENTS.md).
- **Function above the complexity ceiling** — ESLint (`complexity`) fails any function whose cyclomatic complexity is above 40 and names it, or gives the line of an anonymous one: every `if`, loop, `case`, `catch`, `&&`, `||`, `??`, `?:`, `?.` and default value adds one. Split the function; do not add an `eslint-disable`. The `eslint-disable-next-line complexity` lines in `src/` mark the functions that predate the ceiling: they must not grow (`cd cli && ../node_modules/.bin/eslint --no-inline-config <file>` prints the current value). Once such a function fits, its directive no longer applies: `mise //cli:eslint` (`--fix`) deletes it and `mise //cli:eslint:check` reports it as unused. Commit the deletion.
- **Test that cannot fail** — ESLint (`eslint-plugin-jest`) rejects the shapes that pass without checking anything. `fail()` does not exist in Jest: assert the rejection (`await expect(promise).rejects.toThrow(...)`), or keep the error from a `.catch()` and assert on it. Every test needs its own `expect()` call, with a matcher, and an async assertion must be awaited; the fake-timer idiom that keeps `expect(p).rejects…` and awaits it after advancing the timers takes `// eslint-disable-next-line jest/valid-expect -- <reason>`, because the autofix would `await` it on the spot and hang the test. No `expect` outside a test, and no title twice in one `describe`.
- **Exit code leaks** — Command tests must reset `process.exitCode` or Jest exits non-zero despite green assertions.
- **Un-attributed AWS SDK client (#319)** — build clients via `makeClient(Ctor, cfg)` / `makeDocClient(cfg)` from `src/ua.ts`; a naked `new XxxClient({})` silently drops solution attribution. ESLint rejects `new XxxClient(...)` in `src/` (`no-restricted-syntax`); it matches the name at the `new` site, so it does not see an alias or a service class without the `Client` suffix.
