# ADR-021 P3: paused-server HTTP transport control

Date: 2026-09-16. Local diagnostic completed; the original AWS resume refusal
was **not reproduced**. No application code or AWS deployment changed.

## Question

The full-agent hooks sometimes reuse one HTTP connection across suspension.
Could an old connection fail after a pause even though the server still accepts
new connections? This is a narrower question than the four recorded
[AWS resume refusals](./645-p3-resume-refusal-investigation.md).

The earlier full-agent observer measured a 363.501-second wall-clock gap and
363.507-second monotonic-clock gap across one long suspension, with the child
still owning its listener afterward. Another long case measured 367.621 and
367.620 seconds respectively. Thus elapsed-time timers advanced during those
observed freezes.

## Isolated experiment

Eight cases ran in a disposable ARM64 Linux container, with no external network
or AWS credentials. It used Python 3.13.13, Uvicorn 0.50.0, FastAPI 0.139.0,
the asyncio loop and the h11 HTTP implementation. The cached image digest was
`sha256:37a88f276acd700dbd0d6d2a69eff2536180bde11620b6084220414d8d2b63f2`.

A minimal FastAPI application acknowledged `/suspend` and `/resume`. The
controller stopped the server process with `SIGSTOP` for one or six seconds,
then continued it with `SIGCONT`. These signals pause and restart a process.
They do not perform an AWS MicroVM snapshot or restore its networking.

Each duration was tested with the wake request queued before continuation or
sent just afterward. The comparison response included `Connection: close`,
which tells an HTTP client to open a new connection for its next request.
Every case also made a separate fresh connection and checked that the server
was still alive.

| Response behavior | Pause | Request relative to continuation | Wake result | Fresh connection |
|---|---:|---|---|---|
| Default keep-alive | 1 s | After | 200 | 200 |
| Default keep-alive | 1 s | Queued before | 200 | 200 |
| Default keep-alive | 6 s | After | Connection reset, errno 104 | 200 |
| Default keep-alive | 6 s | Queued before | 200 | 200 |
| Connection close | 1 s | After | 200 | 200 |
| Connection close | 1 s | Queued before | 200 | 200 |
| Connection close | 6 s | After | 200 | 200 |
| Connection close | 6 s | Queued before | 200 | 200 |

All eight server processes remained alive until explicit test cleanup. The
container exited successfully and its absence was verified.

## Interpretation and next reproduction

One reused connection reset after exceeding the server's five-second keep-alive
timeout. That is different from a new connection being refused: the listener
remained reachable in every case. This does not establish how AWS classifies
its underlying transport errors. Some original failures followed suspension by
less than five seconds, so simple keep-alive expiration does not explain all
four recorded failures.

The next bounded AWS comparison should:

1. Preserve the original server command and its position as the first process
   in the guest. The previous parent observer changed that position.
2. Compare the deployed image with a diagnostic variant that changes only
   lifecycle response connection handling. Preserve exact artifact hashes.
3. Use fresh owned task IDs for ordinary approval and supervisor-only wake.
   Record AWS request IDs, actual worker states, hook entry/response times,
   connection identity and available process/listener observations.
4. Stop and preserve evidence on a refusal. Determine whether the process died,
   the listening socket disappeared, or a healthy listener was unreachable.
5. Apply a correction only when supported by the failing path, then demonstrate
   the same trigger passing and recheck normal approval, denial, deadlines and
   credential renewal. A few successful comparison runs alone do not prove a fix.
6. Remove only new owned resources. The deployed image and its existing roles
   are comparison inputs and must not be deleted by fixture cleanup.

This AWS comparison is planned, not executed by this local experiment.
Production automatic suspension remains off.

Scripts, raw results and the clock comparison are retained privately under
`/Users/sphias/.local/share/abca-verification/645-p3-20260916/transport-control`.
