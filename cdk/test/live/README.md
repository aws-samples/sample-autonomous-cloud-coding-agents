# MicroVM live probes

These scripts create synthetic task records, S3 objects and short-lived workers
in an existing deployment. They are excluded from Jest. Use an owned, quiet test
deployment with `NO_INGRESS`, a working image version, AWS CLI v2, and credentials
authorized for its resources. Concurrent tasks can invalidate worker attribution.

From `cdk/`, inspect cases and effects without calling AWS:

```sh
mise exec -- node -r ts-node/register/transpile-only test/live/verify-microvm-start.live.ts
mise exec -- node -r ts-node/register/transpile-only test/live/verify-microvm-payload.live.ts
mise exec -- node -r ts-node/register/transpile-only test/live/verify-microvm-replay.live.ts
```

To execute, supply every target field and a private output directory:

```sh
mise exec -- node -r ts-node/register/transpile-only test/live/verify-microvm-start.live.ts \
  --execute --account YOUR_ACCOUNT_ID --region YOUR_REGION \
  --stack YOUR_STACK --image-version YOUR_IMAGE_VERSION \
  --output /tmp/microvm-start-verification
```

Use the same arguments for the other two scripts, with separate output
directories. Start/payload probes also accept `--cases` with comma-separated
names from their inspection output. The replay probe includes waits beyond five
minutes. An assertion failure is a failed verification, even if some cases pass.
Inspect the output and worker inventory after interruption; do not assume cleanup
completed. Never publish raw output containing task data or payload URLs.

The scripts test launch recovery, payload handling and service replay behavior.
They do not replace the [approval and replacement acceptance checks](../../../docs/verification/README.md).
