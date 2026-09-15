# Solution User-Agent wire-capture runbook (#319 / #345)

Manual verification that outbound AWS calls carry the solution-attribution
`User-Agent`, observed **on the wire** rather than through CloudTrail.

`docs/scripts/sync-starlight.mjs` does not mirror `docs/verification/`, so this
file intentionally stays here and is not part of the Starlight site.

## Why a wire check (what the unit tests can't prove)

Every attributed AWS call carries two segments:

```
app/uksb-wt64nei4u6#{AWS_SDK_UA_APP_ID}   <- injected by the SDK/botocore itself, from the env var
md/uksb-wt64nei4u6#{component}            <- from our helper (abcaUserAgent() / ua.py)
```

The unit tests (`cdk/test/handlers/shared/ua.test.ts`, `agent/tests/test_ua.py`,
`cli/test/ua.test.ts`) assert the **helper** returns the correct `md/…` string.
They cannot assert the `app/…` segment: it is **SDK-native** — our code never
produces it, the SDK adds it from `AWS_SDK_UA_APP_ID` at request-build time. The
only ways to confirm the *assembled* header are CloudTrail or a wire capture, and
**CloudTrail is unavailable in this account** (DynamoDB data events are blocked).
These scripts capture the header on the request as it is finalized, so they see
exactly what leaves the process.

This is the regression guard for the recurring hazard called out in
[`AGENTS.md`](../../AGENTS.md): *"Dropping solution UA on a new AWS client (#319)."*

## Scripts

| Tier | Path | Helper under test |
|------|------|-------------------|
| CDK / Node (SDK v3) | `cdk/scripts/ua-wire-check.ts` | `cdk/src/handlers/shared/ua.ts` (`abcaUserAgent()`) |
| Agent / Python (boto3) | `agent/scripts/diagnostics/ua_wire_check.py` | `agent/src/ua.py` (`client_config()`) |

Both import the **real** helper (no mirror → no drift), build clients exactly as
production does, and capture the `User-Agent` at request-build time — so even a
permissions failure still prints the header before the call errors.

> These are **manual, credentialed** diagnostics, not CI tests. They need live
> AWS credentials and make real (read-only) API calls (`sts:GetCallerIdentity`,
> `dynamodb:ListTables`, `s3:ListBuckets`, `secretsmanager:ListSecrets`,
> `lambda:GetAccountSettings`). They live in `scripts/` dirs that are outside the
> lint / type-check / dead-code scopes by design.

## Run — CDK / Node tier

From `cdk/`:

```bash
AWS_PROFILE=admin AWS_REGION=us-east-1 \
AWS_SDK_UA_APP_ID='uksb-wt64nei4u6#integ-1910531' \
ABCA_COMPONENT=orchestr \
npx tsx scripts/ua-wire-check.ts
```

- Vary `ABCA_COMPONENT` (`api` | `orchestr` | `webhook` | `agent`) to see each
  `md/…#{component}` label. Unset → defaults to `api`.
- Set `AWS_SDK_UA_APP_ID=''` to confirm the `app/` segment **drops** (the
  customer opt-out path).

## Run — Agent / Python tier

From the repo root, using the agent venv (has boto3):

```bash
AWS_PROFILE=admin AWS_REGION=us-east-1 \
AWS_SDK_UA_APP_ID='uksb-wt64nei4u6#integ-1910531' \
agent/.venv/bin/python agent/scripts/diagnostics/ua_wire_check.py
```

The `md/` component is hard-wired to `agent` in `ua.py` (this surface *is* the
agent), so there is no `ABCA_COMPONENT` knob on this tier.

## What a pass looks like

For each call the script prints the captured header and a check line. A pass
shows **both** segments present (and `contains md/uksb-wt64nei4u6#… ? YES`):

```
[DynamoDB ListTables]
  User-Agent:        aws-sdk-js/... app/uksb-wt64nei4u6#integ-1910531 md/uksb-wt64nei4u6#orchestr ...
  contains md/uksb-wt64nei4u6#... ? YES
```

- **`app/` present** ⇒ the SDK is honoring `AWS_SDK_UA_APP_ID`.
- **`md/` present** ⇒ the helper is spread into the client correctly.
- With `AWS_SDK_UA_APP_ID=''`, the `app/` segment is absent while `md/` remains —
  confirming opt-out affects only the customer segment.

The read-only calls may fail on permissions; that is fine — the header is
captured **before** the response, so a `... call errored after UA capture` line
still follows a valid header print.
