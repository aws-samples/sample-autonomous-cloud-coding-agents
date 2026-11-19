# RFC 0001: Signed receipts at the ABCA tool gateway

**Status:** Design proposal for review. Scope is buffered MCP `tools/call` requests routed through a configured Amazon Bedrock AgentCore Gateway. This PR changes documentation only.

**Author disclosure:** Tom Farley wrote the receipt-format Internet-Draft. Of the four implementations referenced in the original proposal, three are his (protect-mcp, protect-mcp-adk and sb-runtime); the APS implementation is independently authored. This design requires no particular package. It follows the [interceptor design proposed in review](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/40#issuecomment-4284866801).

## 1. What an operator can verify

An ABCA reviewer should be able to check, offline, that a signer outside the agent runtime recorded a particular tool request before allowing it to proceed, and see which response, if any, the gateway later presented to the response interceptor. The proposed signer is in the gateway's synchronous path; the existing native policy engine stays attached in `ENFORCE` mode.

Three observations have different authorities:

| Observation | Authority and meaning |
| --- | --- |
| Request admitted or stopped by the interceptor | The request signer saw the effective request and made this local decision. Admission lets processing continue. |
| Native Cedar allow or deny | The policy engine makes this decision. When tracing is enabled, its `AuthorizeAction` span can carry the native verdict. The documented request-interceptor payload contains no native verdict. Keep native evidence separate and attribute it to the policy engine only when reliably correlated. |
| Response observed | The response signer saw the recorded response at this boundary. A returned value, error, or timeout does not by itself establish external side effects, successful delivery to the agent, or exactly-once execution. |

A missing receipt leaves the call unobserved at that stage. Gateway authentication failures, upstream denials, calls outside this gateway, and local commands can fall outside the record. For coverage of a tool, restrict its target so the agent cannot invoke it directly. A complete claim about a whole agent run would also require an independent inventory of calls and a trusted terminal checkpoint.

## 2. The request and response paths

Use the gateway's supported [REQUEST and RESPONSE Lambda interceptors](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html). A gateway supports one configured interceptor of each type. Compose this logic with any existing interceptor, preserving its validation and redaction, or use a dedicated pilot gateway. Start with one tool and exclude streaming.

1. **REQUEST** authenticates the run/attempt binding, applies the configured admission checks, and builds a receipt over the final request it would forward. The handler awaits signing **and** a successful durable append before returning `transformedGatewayRequest`. To stop a call it returns a `transformedGatewayResponse` carrying a protocol error. If signing or persistence fails it takes the stop path, even if it cannot issue a signed failure receipt. Native policy remains authoritative wherever the gateway evaluates it.
2. **RESPONSE** resolves the request using a trusted per-attempt binding, applies any response transformation or redaction, and signs a receipt over precisely the response it proposes to return. It awaits the append before returning that response. A synthetic response from REQUEST also invokes RESPONSE. Track the disposition of this invocation, including local rejection of a duplicate attempt. Never attach that synthetic denial to the originally admitted attempt as its target outcome. Record a forwarded call's result as a **gateway response** unless its target origin is independently established. Leave it unattributed when correlation is ambiguous.
3. A failed response write after forwarding produces an audit error and a pending request with unresolved outcome. Operators reconcile such requests with available gateway or target evidence. A response-stage failure must never trigger a fresh tool call. Signing and storage after the handler has returned cannot guard forwarding.

Correlation is an integration requirement. An orchestrator-issued attempt identifier must be authenticated and bound to the run, tool and request digest. Verify that both hooks can recover the same binding via a supported context or integrity-protected field that survives the gateway. A client-supplied JSON-RPC ID, header, timestamp or identical tool input alone is insufficient. The [documented MCP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html) shows separate raw and effective request bodies. Leave request recording disabled for tools without a trusted binding, or reject them on a receipt-required gateway. Do not disclose authorization headers or use raw credentials as a run identity.

## 3. Receipt format and offline verification

Use the envelope form in [draft-farley-acta-signed-receipts-03, §§2, 5 and 6](https://www.ietf.org/archive/id/draft-farley-acta-signed-receipts-03.html). Pin the format version for the pilot. The following is illustrative **input to signing**, with fictional identifiers. The request digest covers `{"arguments":{"task":"demo"},"name":"repo___get_diff"}`. The namespaced type and gateway-specific fields are proposed ABCA extensions.

```json
{
  "type": "abca:gateway-request",
  "issued_at": "2026-04-18T01:40:00Z",
  "issuer_id": "abca-pilot-k1",
  "gateway_id": "pilot-gateway",
  "run_id": "run-01",
  "attempt_id": "attempt-01",
  "sequence": 1,
  "tool_name": "repo___get_diff",
  "request_digest": "sha256:cc518448d1745a9f9a5997818c769e596088e1ab38e78d6a67dc1a973ac0cf03",
  "disposition": "admit"
}
```

- Canonicalize the payload with RFC 8785 JCS. Preserve Unicode code points. Sign its UTF-8 bytes with pure Ed25519, then emit the envelope with `payload` and `signature` (`alg`, `kid`, `sig`). The key ID matches the signed issuer. Keep raw arguments, prompts, headers and results out of the receipt. Document the exact digest input (JCS of the effective tool name and arguments for requests, JCS of the final MCP response body for responses); digests of guessable values can still disclose information.
- For each subsequent entry in a run, put `previousReceiptHash` **inside the signed payload**. Its value is `sha256:` plus lowercase hex SHA-256 over the JCS bytes of the entire previous signed envelope. The first entry omits the member. A response payload of type `abca:gateway-response` separately carries the digest of its own request **receipt**, the attempt ID, response status and digest. Under concurrency, the preceding entry can belong to another call.
- An offline verifier receives the allowed export plus an independently authenticated key set, rotation history and, when available, an independently retained terminal (run ID, sequence, hash). Verify signatures, supported algorithms and issuer bindings, contiguous sequence and chain links, and request/response associations. Flag duplicate phases and outstanding requests. A valid prefix can survive removal of the tail; only a trusted checkpoint can detect truncation to a shorter prefix. These checks authenticate signer statements. They do not validate a model's reasoning or confer trust on caller-supplied metadata.

## 4. Proposed CDK resources and persistence

| Resource | Configuration |
| --- | --- |
| Gateway and Lambda | Attach a request handler and a response handler with `interceptionPoints` set to `REQUEST` and `RESPONSE` respectively. The gateway role may invoke only the configured functions. Keep caller headers disabled unless the binding design needs specific trusted material. |
| KMS | Use `ECC_NIST_EDWARDS25519`, key usage `SIGN_VERIFY`, algorithm `ED25519_SHA_512`, message type `RAW`. Bound the canonical payload to the [KMS Sign limit](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html) of 4,096 bytes. Reject oversized receipts. Prehashing would change this signature contract. |
| Receipt bucket | Private, encrypted, versioned, bucket-owner enforced, CDK `s3.BlockPublicAccess.BLOCK_ALL`. Require TLS and conditional, create-only entry writes. The handlers need narrowly scoped read/list/put access to maintain the sequence, with no delete access. Provide authorized exports separately; the bucket stays private. Set retention and optional Object Lock under the deployment's own policy. |
| IAM | Give only the designated handler identities signing access to this key. Deny agent runtime principals signing, receipt-store mutation and direct interceptor invocation. Keep key administration, handler updates and archive/retention administration separate from the agent. Check target IAM and alternate credentials for bypasses. |
| Signing audit | Reuse one CloudTrail trail that includes KMS read and write **management events**, with KMS inclusion checked explicitly. The [CloudTrail example for Sign](https://docs.aws.amazon.com/kms/latest/developerguide/ct-sign.html) is classified read-only. Query `kms.amazonaws.com` / `Sign` for the signer and key. The signer can store the successful KMS request ID as operational metadata to aid reconciliation. There is no second trail or Lake store in this proposal. [CloudTrail Lake closed to new customers in May 2026](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-lake-service-availability-change.html). |

For a low-volume pilot, use a session prefix and immutable, numbered S3 entry keys. Read the contiguous entries for the run, checking for an existing (attempt, phase) before choosing the next sequence and signing. Try appending that sequence using [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) (`If-None-Match: *`). If another invocation wins, re-read and retry against the new predecessor within a bounded time. On an ambiguous timeout, read the entry before proceeding. An identical event can reuse its persisted receipt during reconciliation; a different payload for the same attempt/phase is a conflict. A duplicate request must not forward another tool call on the strength of the prior receipt. Reject ambiguous retries and leave resolution to the caller/operator. This favors a safe missing outcome over executing an irreversible action twice. Measure latency and contention before selecting any higher-throughput design.

A compromised signing role can sign false statements. A KMS invocation trail can flag unexpected key use; it cannot establish the truth of the signed content. Retries and losing a conditional append can legitimately produce more signatures than stored receipts. Review evidence accordingly.

## 5. What to validate before an implementation PR

- **Gateway lifecycle.** Exercise native permit and native deny, local rejection, target success and target error. Record which hooks run, what each receives, and whether both hooks can recover a trusted attempt binding. Verify that a local rejection invoking RESPONSE produces zero target invocations. Use a target with an independent invocation counter.
- **Failure handling.** Inject faults before KMS signing, before and after S3 commit, after request commit but before target execution, and after a target side effect but before response commit. Check timeout and malformed Lambda return behavior, duplicate IDs, conflicting retries and concurrent calls in the same run. After a request is admitted, resend its ID and verify the locally generated duplicate denial cannot fill the original attempt’s pending outcome. Verify outstanding attempts can be reconciled without rerunning the tool.
- **Native evidence.** If the deployment requires a receipt covering a Cedar verdict, validate the mapping from the actual [policy observability spans](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-policy-metrics.html) to this attempt. If the trace is absent, sampled or ambiguous, report native decision unknown.
- **Offline replay.** Run two interleaved calls. Verify the intact export against a pinned key, then test a substituted key, altered input digest, swapped entries, swapped responses, duplicate phase and a truncated export with and without a trusted checkpoint. Test timeouts and p95 added latency against an operator-agreed budget.

The open questions for maintainers are which trusted ABCA run/attempt binding to use, whether existing gateway interceptors need composing, and which target and latency budget to use for a first integration test. No resources are deployed and the lifecycle tests above are proposed acceptance criteria.

### Service references

- [AgentCore gateway interceptor configuration and limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors.html)
- [AgentCore gateway examples, including interceptor configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-create-api.html)
- [Native policy enforcement](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html)
- [KMS Ed25519 key and message types](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
- [KMS audit events and fields omitted from CloudTrail](https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html)
