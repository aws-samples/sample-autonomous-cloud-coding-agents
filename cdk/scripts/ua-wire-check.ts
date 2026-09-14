/**
 * UA wire-capture check (#319 / PR #345) — standalone, NOT part of the CDK app.
 *
 * Proves the outbound AWS SDK `User-Agent` carries both solution-attribution
 * segments WITHOUT relying on CloudTrail (this account blocks DynamoDB data
 * events, so the wire is the only place to observe them):
 *
 *     app/uksb-wt64nei4u6#{AWS_SDK_UA_APP_ID}   <- SDK reads the env var natively
 *     md/uksb-wt64nei4u6#{ABCA_COMPONENT}       <- from the REAL abcaUserAgent() helper
 *
 * It imports the PR's actual helper (src/handlers/shared/ua.ts) — no mirror —
 * spreads it into real SDK v3 clients exactly as the handlers do, attaches a
 * finalizeRequest middleware that captures the assembled User-Agent header, and
 * makes one cheap read-only call per service. The call may even fail on perms;
 * the UA is captured at request-build time, before the response, so failures
 * still print the header.
 *
 * Run (from the cdk/ dir):
 *   AWS_PROFILE=admin AWS_REGION=us-east-1 \
 *   AWS_SDK_UA_APP_ID='uksb-wt64nei4u6#integ-1910531' \
 *   ABCA_COMPONENT=orchestr \
 *   npx tsx scripts/ua-wire-check.ts
 *
 * Vary ABCA_COMPONENT (api | orchestr | webhook | agent) to see each md/ label.
 * Set AWS_SDK_UA_APP_ID='' to confirm the app/ segment drops (customer opt-out).
 *
 * See docs/verification/319-ua-wire-runbook.md for the full runbook.
 */

import { LambdaClient, GetAccountSettingsCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  SecretsManagerClient,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { HttpRequest } from '@smithy/protocol-http';

// The REAL PR helper — this is the thing under test, not a copy.
import { abcaUserAgent, SOLUTION_ID, COMPONENT_ENV } from '../src/handlers/shared/ua';

/**
 * Middleware that prints every User-Agent-ish header on the finalized request.
 * finalizeRequest runs AFTER the SDK's user-agent middleware (build step), so
 * the header is fully assembled — app/ from the env var + md/ from the helper.
 */
const captureUa = (label: string) => ({
  applyToStack: (stack: any) => {
    stack.add(
      (next: any) => async (args: any) => {
        const req = args.request;
        if (HttpRequest.isInstance(req)) {
          const ua =
            req.headers['user-agent'] ?? req.headers['User-Agent'] ?? '(none)';
          const xua =
            req.headers['x-amz-user-agent'] ??
            req.headers['X-Amz-User-Agent'] ??
            '(none)';
          // eslint-disable-next-line no-console
          console.log(`\n[${label}]`);
          // eslint-disable-next-line no-console
          console.log(`  User-Agent:        ${ua}`);
          // eslint-disable-next-line no-console
          console.log(`  x-amz-user-agent:  ${xua}`);
          const want = `md/${SOLUTION_ID}`;
          // eslint-disable-next-line no-console
          console.log(
            `  contains ${want}#... ? ${
              String(ua).includes(want) || String(xua).includes(want)
                ? 'YES'
                : 'NO'
            }`,
          );
        }
        return next(args);
      },
      { step: 'finalizeRequest', name: `captureUa-${label}`, priority: 'low' },
    );
  },
});

async function main(): Promise<void> {
  const appId = process.env.AWS_SDK_UA_APP_ID;
  const component = process.env[COMPONENT_ENV];
  // eslint-disable-next-line no-console
  console.log('=== UA wire-capture (#345) ===');
  // eslint-disable-next-line no-console
  console.log(`AWS_SDK_UA_APP_ID = ${appId ?? '(unset → no app/ segment)'}`);
  // eslint-disable-next-line no-console
  console.log(`${COMPONENT_ENV} = ${component ?? '(unset → defaults to api)'}`);
  // eslint-disable-next-line no-console
  console.log(`Expecting md/${SOLUTION_ID}#${component ?? 'api'} on every call.`);

  // Generic / "trivial" client — no specific resource, just a plain SDK v3
  // client built the same way (spread the helper). GetAccountSettings needs no
  // resource and minimal perms, so it's the Node-tier analogue of STS
  // GetCallerIdentity: proves the UA on an arbitrary client, not a special one.
  const lambda = new LambdaClient({ ...abcaUserAgent() });
  lambda.middlewareStack.use(captureUa('Lambda GetAccountSettings (generic)'));

  // Each client built EXACTLY like the handlers: spread the real helper in.
  const ddb = new DynamoDBClient({ ...abcaUserAgent() });
  ddb.middlewareStack.use(captureUa('DynamoDB ListTables'));

  const s3 = new S3Client({ ...abcaUserAgent() });
  s3.middlewareStack.use(captureUa('S3 ListBuckets'));

  const sm = new SecretsManagerClient({ ...abcaUserAgent() });
  sm.middlewareStack.use(captureUa('SecretsManager ListSecrets'));

  // Cheap read-only calls. Wrapped so a perms failure still lets the others run
  // (the UA is already printed by the middleware before any error surfaces).
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`  (${name} call errored after UA capture: ${(err as Error).name})`);
    }
  };

  await run('lambda', () => lambda.send(new GetAccountSettingsCommand({})));
  await run('ddb', () => ddb.send(new ListTablesCommand({ Limit: 1 })));
  await run('s3', () => s3.send(new ListBucketsCommand({})));
  await run('sm', () => sm.send(new ListSecretsCommand({ MaxResults: 1 })));
}

void main();
