# Backlog: CLI doesn't handle Cognito `NEW_PASSWORD_REQUIRED` challenge

> **Status:** Backlog — to be worked in a separate session
> **Severity:** Medium — blocks first-time user login without admin intervention
> **Discovered:** 2026-04-16 during Phase 1a deployment to account `169728770098`

---

## Problem

When a user is created in Cognito via the `AdminCreateUser` flow (the default for ABCA — the stack creates the first admin user with a temporary password), Cognito puts the user in `FORCE_CHANGE_PASSWORD` state. On first login, Cognito's `InitiateAuth` call returns a `ChallengeName: "NEW_PASSWORD_REQUIRED"` response instead of `AuthenticationResult`.

The ABCA CLI's `login` command (`cli/src/auth.ts`) calls `InitiateAuthCommand` with `AuthFlow: USER_PASSWORD_AUTH`, expects an `AuthenticationResult` in the response, and throws `"Unexpected authentication response from Cognito"` when it encounters the challenge instead.

## Reproduction

1. Deploy the ABCA stack to a fresh AWS account
2. The stack auto-creates a user in the Cognito pool with a temporary password
3. `bgagent configure ...` (works)
4. `bgagent login --username <email>` → enter temporary password → **"Error: Unexpected authentication response from Cognito."**

Verify the user state:

```bash
aws cognito-idp list-users \
  --user-pool-id <user-pool-id> \
  --region <region> \
  --query 'Users[].[Username,UserStatus]' \
  --output table
```

Expected: `UserStatus: FORCE_CHANGE_PASSWORD`

## Current workaround

Admin-set a permanent password to bypass the challenge:

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id <user-pool-id> \
  --username <email> \
  --password 'NewPassword123!' \
  --permanent \
  --region <region>
```

This works but requires AWS admin access — not acceptable for users onboarding onto a shared ABCA deployment.

## Root cause

File: `cli/src/auth.ts` (login flow)

The current implementation (as of `feature/interactive-background-agents`) only handles the `AuthenticationResult` response path from `InitiateAuthCommand`. The `ChallengeName` path (specifically `NEW_PASSWORD_REQUIRED`, but also potentially `SMS_MFA`, `SOFTWARE_TOKEN_MFA`, `MFA_SETUP`) is not handled, triggering a generic error.

Test coverage for `login.ts` is currently 37% (per `jest --coverage` output) — the challenge paths are uncovered.

## Design for the fix

### Scope

**In scope:**
- `NEW_PASSWORD_REQUIRED` challenge — most common first-login flow
- User-visible error messaging when password doesn't meet the pool's password policy

**Out of scope (separate backlog items):**
- `SMS_MFA` / `SOFTWARE_TOKEN_MFA` — deferred to MFA feature (mentioned in Iteration 4)
- `MFA_SETUP` — ditto
- `DEVICE_SRP_AUTH` — not used by this CLI
- `SELECT_MFA_TYPE` — ditto

### Proposed behavior

When `bgagent login` receives a `NEW_PASSWORD_REQUIRED` challenge:

1. Print an informational message: `"Your password must be changed on first login."`
2. Prompt for a new password (hidden input, using the existing `readPassword` helper)
3. Prompt to confirm the new password (reject if mismatched)
4. Call `RespondToAuthChallengeCommand` with:
   - `ChallengeName: "NEW_PASSWORD_REQUIRED"`
   - `ChallengeResponses: { USERNAME: <username>, NEW_PASSWORD: <new_password> }`
   - `Session: <session-from-challenge>`
5. On success: receive `AuthenticationResult`, cache tokens as usual, print "Login successful."
6. On `InvalidPasswordException`: print the policy requirements (or the Cognito error message) and re-prompt (up to 3 attempts before aborting)

### Files to modify

| File | Change |
|------|--------|
| `cli/src/auth.ts` | Handle `ChallengeName === "NEW_PASSWORD_REQUIRED"` branch in the login flow; add `RespondToAuthChallengeCommand` path |
| `cli/src/commands/login.ts` | Add CLI prompts for new password + confirmation; pass through to auth module |
| `cli/test/auth.test.ts` | Add tests for challenge handling (see test cases below) |
| `cli/test/commands/login.test.ts` | Add tests for the command-level prompt flow |

### API reference

AWS SDK v3 (already a dependency):

```typescript
import {
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AuthFlowType,
  ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';

// After InitiateAuth returns ChallengeName: NEW_PASSWORD_REQUIRED:
const response = await client.send(new RespondToAuthChallengeCommand({
  ClientId: clientId,
  ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED,
  Session: initiateAuthResponse.Session,
  ChallengeResponses: {
    USERNAME: username,
    NEW_PASSWORD: newPassword,
  },
}));
// response.AuthenticationResult contains IdToken, AccessToken, RefreshToken
```

## Test cases

### Unit tests — `cli/test/auth.test.ts`

1. **Challenge triggers new-password flow**
   - Mock `InitiateAuthCommand` to return `{ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "sess-123" }`
   - Mock `RespondToAuthChallengeCommand` to return `{ AuthenticationResult: { IdToken: "...", AccessToken: "...", RefreshToken: "..." } }`
   - Mock password prompt to return a valid new password (both entries matching)
   - Assert: `RespondToAuthChallengeCommand` called with correct ChallengeName, Session, USERNAME, NEW_PASSWORD
   - Assert: tokens are cached to `~/.bgagent/credentials.json`
   - Assert: function resolves successfully

2. **Mismatched password confirmation fails clearly**
   - Mock challenge response path as above
   - Mock password prompts to return different values on first call and second call
   - Assert: throws/exits with clear "passwords do not match" message (no API call made)

3. **InvalidPasswordException surfaces policy error**
   - Mock `RespondToAuthChallengeCommand` to throw `InvalidPasswordException` with message
   - Assert: error message contains the Cognito-returned policy requirement
   - Assert: exit code is 1 (or error is re-raised from the async function)

4. **Normal login unaffected (regression)**
   - Mock `InitiateAuthCommand` to return `{ AuthenticationResult: { ... } }` (no challenge)
   - Assert: `RespondToAuthChallengeCommand` NOT called
   - Assert: tokens cached, function resolves

5. **Unhandled challenge types still error clearly**
   - Mock `InitiateAuthCommand` to return `{ ChallengeName: "SMS_MFA" }`
   - Assert: throws with message mentioning the unsupported challenge type (so users know what's happening, vs the current generic "Unexpected response")

### Integration smoke test (manual, not automated — documented for QA)

Against a fresh deployment:

1. Deploy stack to a new AWS account
2. Wait for the admin user to be created by the stack (user status = `FORCE_CHANGE_PASSWORD`)
3. `bgagent configure ...`
4. `bgagent login --username <email>` — enter temp password, then new password + confirmation
5. Verify: login succeeds, tokens cached
6. Verify: `aws cognito-idp admin-get-user ...` shows `UserStatus: CONFIRMED`
7. Verify: subsequent `bgagent login` with the new password (no challenge) works normally
8. Verify: `bgagent list` (or any authenticated command) works with the cached tokens

## Acceptance criteria

- [ ] A user in `FORCE_CHANGE_PASSWORD` state can complete login via `bgagent login` alone (no admin AWS CLI intervention needed)
- [ ] Unit test coverage on `cli/src/auth.ts` rises above 70% (from current ~37% on `login.ts`)
- [ ] All 5 unit test cases above pass
- [ ] Integration smoke test documented in developer guide as a post-deploy verification step
- [ ] Other Cognito challenges (`SMS_MFA`, `MFA_SETUP`, etc.) produce a clear error message identifying the unsupported challenge type, not a generic "unexpected response"
- [ ] No regression to the normal login path (existing tests still pass)

## Related

- Current user-visible error: `Error: Unexpected authentication response from Cognito.`
- Error location: `cli/src/auth.ts` (login function — check for `AuthenticationResult` absence)
- AWS docs: [Authentication flows for Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow.html)
- SDK docs: [`RespondToAuthChallengeCommand`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cognito-identity-provider/command/RespondToAuthChallengeCommand/)
