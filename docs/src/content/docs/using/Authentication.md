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
3. **Call the API** - Every request includes the token in the `Authorization: Bearer <token>` header.
4. **Validate** - API Gateway's Cognito authorizer verifies the JWT signature, expiration, and audience. Invalid tokens are rejected with `401`.
5. **Extract identity** - The Lambda handler reads the `sub` claim from the validated JWT and uses it as `user_id` for task ownership and audit.

**Webhook flow:**

1. **Send request** - The external system (CI pipeline, GitHub Actions) sends a `POST` to `/v1/webhooks/tasks` with two headers: `X-Webhook-Id` (identifies the integration) and `X-Webhook-Signature` (`sha256=<hex>`).
2. **Check webhook exists** - A Lambda REQUEST authorizer verifies that the webhook ID exists and is active in DynamoDB. Revoked or unknown webhooks are rejected with `403`.
3. **Verify signature** - The handler fetches the webhook's shared secret from AWS Secrets Manager, computes `HMAC-SHA256(secret, raw_request_body)`, and compares it to the provided signature using constant-time comparison (`crypto.timingSafeEqual`). Mismatches are rejected with `403`.
4. **Extract identity** - The `user_id` is the Cognito user who originally created the webhook integration. Tasks created via webhook are owned by that user.

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

### Create a user (admin)

```bash
aws cognito-idp admin-create-user \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --temporary-password 'TempPass123!@'

aws cognito-idp admin-set-user-password \
  --region "$REGION" \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --password 'YourPerm@nent1Pass!' \
  --permanent
```

Password requirements: minimum 12 characters, uppercase, lowercase, digits, and symbols.

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