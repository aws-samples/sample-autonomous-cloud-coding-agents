---
title: Authentication
---

The platform uses two authentication mechanisms depending on the channel:

- **CLI / REST API** - Amazon Cognito User Pool with JWT tokens. Self-signup is disabled; an administrator must create your account.
- **Webhooks** - HMAC-SHA256 signatures using per-integration shared secrets stored in AWS Secrets Manager.

Both channels are protected by AWS WAF at the API Gateway edge (rate limiting, common exploit protection). Downstream services never see raw tokens or secrets - the gateway extracts the user identity and attaches it to internal messages.

```mermaid
flowchart TB
    subgraph "CLI / REST API"
        U[User] -->|username + password| C[Amazon Cognito]
        C -->|JWT ID token| U
        U -->|Authorization: Bearer token| GW[API Gateway]
        GW -->|Cognito authorizer validates JWT| L[Lambda handler]
    end

    subgraph "Webhook"
        E[External system] -->|POST + HMAC signature| GW2[API Gateway]
        GW2 -->|REQUEST authorizer checks webhook exists| L2[Lambda handler]
        L2 -->|Fetches secret from Secrets Manager,\nverifies HMAC-SHA256| L2
    end

    L -->|user_id from JWT sub| T[Task created]
    L2 -->|user_id from webhook owner| T
```

**CLI / REST API flow:**

1. **Authenticate** - The user sends username and password to Amazon Cognito via the CLI (`bgagent login`) or the AWS SDK (`initiate-auth`).
2. **Receive token** - Cognito validates credentials and returns a JWT ID token. The CLI caches it locally (`~/.bgagent/credentials.json`) and auto-refreshes on expiry.
3. **Call the API** - Every request includes the raw ID token (no `Bearer` prefix) in the `Authorization: <token>` header.
4. **Validate** - API Gateway's Cognito authorizer verifies the JWT signature, expiration, and audience. Invalid tokens are rejected with `401`.
5. **Extract identity** - The Lambda handler reads the `sub` claim from the validated JWT and uses it as `user_id` for task ownership and audit.

**Webhook flow:**

1. **Send request** - The external system (CI pipeline, GitHub Actions) sends a `POST` to `/v1/webhooks/tasks` with two headers: `X-Webhook-Id` (identifies the integration) and `X-Webhook-Signature` (`sha256=<hex>`).
2. **Check webhook exists** - A Lambda REQUEST authorizer verifies that the webhook ID exists and is active in DynamoDB. Revoked or unknown webhooks are rejected with `403`.
3. **Verify signature** - The handler fetches the webhook's shared secret from AWS Secrets Manager, computes `HMAC-SHA256(secret, raw_request_body)`, and compares it to the provided signature using constant-time comparison (`crypto.timingSafeEqual`). Mismatches are rejected with `403`.
4. **Extract identity** - The `user_id` is the Cognito user who originally created the webhook integration. Tasks created via webhook are owned by that user.

### Joining an existing deployment

If your team already has ABCA deployed and someone (the "stack admin") has invited you, this is your path. You will **not** run `cdk deploy`, will **not** run `bgagent linear setup`, and will not need AWS credentials. You're a tenant on a shared deployment.

Three steps:

1. **Get a config bundle from your admin.** They run `bgagent admin invite-user your-email@example.com` and send you the output via Slack / 1Password / email. The output looks like:

   ```
   ✓ Created Cognito user your-email@example.com
   ✓ Set temporary password (teammate is prompted to set a permanent one on first login)

   Share with the new teammate:
   ────────────────────────────────────────────────────────────────
     email:         your-email@example.com
     temp password: K9$mPq2nL!vXf3Hb
     bundle:        eyJhcGlfdXJsIjoiaHR0cHM6Ly9hYmMxMjM…
   ────────────────────────────────────────────────────────────────
   ```

   The `bundle` is a base64 blob carrying the four config fields (API URL, region, user pool ID, app client ID) so you don't have to type them as separate flags. The **temp password is a one-time credential** — you'll replace it on first login (below), after which the admin-shared string is no longer valid.

2. **Configure your CLI from the bundle:**

   ```bash
   bgagent configure --from-bundle <paste the base64 string>
   ```

3. **Log in and set your permanent password:**

   ```bash
   bgagent login --username your-email@example.com
   # paste the temp password when prompted for "Password:"
   # then, because this is your first login, you'll be prompted to set a
   # new (permanent) password and confirm it
   ```

   On first login Cognito requires you to rotate the admin-generated temp password. The CLI prompts `New password:` + `Confirm new password:`, sets it, and caches your tokens in `~/.bgagent/credentials.json` (auto-refreshed thereafter). Subsequent logins just use your permanent password. Do this interactively — omit `--password` so the CLI can prompt you.

You're in. `bgagent submit`, `bgagent list`, `bgagent status` work against the shared stack. Tasks you submit are attributed to your Cognito user; concurrency caps and budgets are scoped to you.

Want to rotate your password later? Run `bgagent change-password` (prompts for your current password, then the new one twice). Cognito enforces the pool's password policy — minimum 12 characters with an upper, lower, digit, and symbol.

**You do not run** `bgagent linear setup`, `bgagent jira setup`, `bgagent jira app-setup`, or `bgagent slack setup` — those are workspace-level operations performed once by the stack/workspace admin. If you want Linear- or Jira-triggered tasks to be attributed to *you* (not auto-dropped), the admin needs to map your Linear identity or Jira account to your Cognito user; ask them about [Linear user linking](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#inviting-teammates) or [Jira user linking](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide#6-link-your-jira-identity).

If something looks broken (commands fail with `Not configured` or `401 Unauthorized`), re-paste the bundle and re-run `bgagent login`. The bundle holds no secrets — your password (separate) is the credential.

### Get stack outputs

After deployment, retrieve the API URL and Cognito identifiers. Set `REGION` to the AWS region where you deployed the stack (for example `us-east-1`). Use the same value for all `aws` and `bgagent configure` commands below  - a mismatch often surfaces as a confusing Cognito “app client does not exist” error.

```bash
REGION=<your-deployment-region>

API_URL=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name backgroundagent-dev \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`AppClientId`].OutputValue' --output text)
```

### Invite a teammate (admin)

```bash
bgagent admin invite-user teammate@example.com
```

This wraps Cognito `admin-create-user` with the right defaults (email-verified so the account is usable immediately, suppress-email so SES isn't required) and prints a shareable config bundle plus an auto-generated strong **temporary** password. Send the bundle + temp password to the teammate; they paste them into `bgagent configure --from-bundle <bundle>` + `bgagent login --username <email>`, and on that first login Cognito prompts them to set a permanent password only they know. That first-login rotation means the credential you shared over Slack/email stops being valid once they're in — the admin-generated string is transient by design.

The CLI command requires the running shell to have AWS credentials with `cognito-idp:AdminCreateUser` on the configured user pool — i.e. you're acting as the stack admin, not as a Cognito-authenticated end-user. (No `AdminSetUserPassword` is issued for invites; the teammate rotates their own password on first login. `bgagent admin reset-password` still uses `AdminSetUserPassword` to set a permanent password when an admin must recover an account.)

**Pool constraints** (enforced server-side; the CLI handles them, but useful to know if you ever need to bypass it with raw AWS CLI):

- **Username MUST be an email address.** The pool is configured with email as the sign-in alias.
- **Password policy**: minimum 12 characters, with at least one uppercase, lowercase, digit, and symbol.
- **`email_verified=true` attribute is required.** An invited user sits in `FORCE_CHANGE_PASSWORD` state by design (they rotate the temp password on first login); with `email_verified` set, `initiate-auth` returns the `NEW_PASSWORD_REQUIRED` challenge and login proceeds through it. Without it, `initiate-auth` fails with `User is not confirmed`.
- **`--message-action SUPPRESS`** stops Cognito from trying to email the temp password — required unless you've set up SES verified identities.

#### Raw AWS CLI fallback

If you can't run `bgagent admin invite-user` (e.g., you're scripting this from CI without the CLI installed), the underlying call is:

```bash
aws cognito-idp admin-create-user \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --temporary-password 'TempPass123!@' \
  --message-action SUPPRESS
```

This creates the user with a **temporary** password (state `FORCE_CHANGE_PASSWORD`) and pre-verifies the email — matching what `bgagent admin invite-user` does. The teammate rotates the temp password on their first `bgagent login`. Hand them the temp password plus the four config fields manually (or build the bundle: `echo '{"api_url":"…","region":"…","user_pool_id":"…","client_id":"…"}' | base64`).

> If you deliberately want a login-ready **permanent** password with no first-login prompt (e.g. a service account), add a second call — but for human teammates prefer the rotate-on-first-login default above:
>
> ```bash
> aws cognito-idp admin-set-user-password \
>   --region "$REGION" \
>   --user-pool-id $USER_POOL_ID \
>   --username user@example.com \
>   --password 'YourPerm@nent1Pass!' \
>   --permanent
> ```

### Obtain a JWT token

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --region "$REGION" \
  --client-id $APP_CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=user@example.com,PASSWORD='YourPerm@nent1Pass!' \
  --query 'AuthenticationResult.IdToken' --output text)
```

Use this token in the `Authorization` header for all API requests.