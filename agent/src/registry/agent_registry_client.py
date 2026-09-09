"""Read-side AWS Agent Registry implementation of the ``RegistryClient`` port.

The agent only reads: ``get_record`` and ``resolve``. This is the one Python file
that talks to the Agent Registry control plane (via boto3) — everything upstream uses
the port, so a substrate swap is confined here. Mirrors the read half of
``cdk/src/handlers/shared/registry/agent-registry-client.ts``.
"""

from __future__ import annotations

import base64
import json
import re
from typing import TYPE_CHECKING, Any

import yaml

from registry.client import (
    RegistryRecordMalformedError,
    RegistryResolutionError,
    ResolvedAsset,
)
from registry.resolver import select_highest

if TYPE_CHECKING:
    from registry.ref import ParsedRef

_NAME_SEP = "/"
# Option-A record name is `kind/namespace/name`; the name may itself contain `/`.
_NAME_MIN_PARTS = 2
# The reverse-DNS key under which ABCA runtime config rides in a native `_meta`
# block (matches RUNTIME_META_KEY in registry/types.ts).
_RUNTIME_META_KEY = "dev.abca.runtime"
# Frontmatter key carrying the runtime payload (JSON) in a native SKILL record's
# SKILL.md — mirrors SKILL_RUNTIME_FM_KEY in registry/agent-registry-client.ts.
_SKILL_RUNTIME_FM_KEY = "x-abca-runtime"
# Match the whole frontmatter block between the first ---/--- pair. Parsing it as
# one YAML document (not a per-line regex) keeps a newline-bearing value inside its
# value instead of being read as a second key — but the injection defense proper is
# write-side (buildSkillMd quotes/escapes every value through a YAML dumper); this
# read only avoids masking corruption (#791). Mirrors parseSkillFrontmatter in
# agent-registry-client.ts.
_SKILL_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
_RESOLVABLE_STATUSES = ("APPROVED", "DEPRECATED")


def _decode_descriptor_json(data: str, what: str) -> dict[str, Any]:
    """json.loads a CUSTOM/MCP descriptor body into a dict, boxing any failure as a
    malformed marker (not a raw ValueError/AttributeError) so a corrupt body
    classifies as MALFORMED rather than REMOVED — mirrors parseDescriptorJson in
    agent-registry-client.ts. ``json.loads`` also succeeds on non-objects
    (``null``, ``[1,2]``, ``123``, ``"s"``), and the caller immediately calls
    ``.get`` on the result — so a successful parse that is not a dict is rejected
    here rather than raising an unboxed AttributeError that would escape resolve()
    as an opaque error (#837 review)."""
    try:
        parsed = json.loads(data)
    except (ValueError, TypeError) as exc:
        raise RegistryRecordMalformedError(f"{what} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RegistryRecordMalformedError(f"{what} is not a JSON object")
    return parsed


class AgentRegistryClient:
    """Read-only registry access backed by AWS Agent Registry."""

    def __init__(self, registry_id: str, client: Any) -> None:
        # ``client`` is a boto3 ``agent-registry-control`` client, injected so
        # the agent's scoped-session helper (aws_session) owns credential wiring.
        self._registry_id = registry_id
        self._client = client

    # --- name (Option A) decode -------------------------------------------------

    @staticmethod
    def _decode_name(record_name: str) -> tuple[str, str, str]:
        parts = record_name.split(_NAME_SEP)
        kind = parts[0] if parts else ""
        namespace = parts[1] if len(parts) > 1 else ""
        name = _NAME_SEP.join(parts[_NAME_MIN_PARTS:]) if len(parts) > _NAME_MIN_PARTS else ""
        return kind, namespace, name

    @staticmethod
    def _id_from_arn(arn: str) -> str:
        return arn.split("/")[-1] if "/" in arn else arn

    # --- record extraction ------------------------------------------------------

    def _extract_runtime(self, raw: dict[str, Any]) -> dict[str, Any]:
        descriptors = raw.get("descriptors", {}) or {}
        record_type = raw.get("recordType")
        if record_type == "CUSTOM":
            body = _decode_descriptor_json(
                descriptors.get("custom", {}).get("data", "{}"), "CUSTOM record body"
            )
            return body.get("runtime", {})
        if record_type == "SKILL":
            # SKILL.md is Markdown frontmatter, not JSON — recover the runtime
            # from the `x-abca-runtime` frontmatter key (mirrors the TS adapter).
            skill_md = (
                descriptors.get("agentSkillsDefinition", {})
                .get("additionalData", {})
                .get("skillMd", {})
                .get("data", "")
            )
            m = _SKILL_FRONTMATTER_RE.search(skill_md)
            if not m:
                return {}
            try:
                fm = yaml.safe_load(m.group(1))
            except yaml.YAMLError as exc:
                # A YAML parse failure must NOT collapse to `{}`: that erases the
                # publisher (attribution) and runtime, making a malformed record
                # indistinguishable from an empty one and letting attacker-influenced
                # input drop an audit-critical trust field (#791). Surface it so
                # resolve() rejects the record. Mirrors parseSkillFrontmatter in
                # agent-registry-client.ts.
                raise RegistryRecordMalformedError(
                    f"SKILL.md frontmatter is not valid YAML: {exc}"
                ) from exc
            # An empty block (`---\n\n---`) parses to None — a record legitimately
            # without frontmatter. A block that parses to a non-mapping (a sequence
            # or a bare scalar) is corrupt: reject it as MALFORMED rather than
            # collapse to `{}`, which would hide the corruption the way an
            # unparseable block would (#791 / #837 review).
            if fm is None:
                return {}
            if not isinstance(fm, dict):
                raise RegistryRecordMalformedError("SKILL.md frontmatter is not a mapping")
            raw_value = fm.get(_SKILL_RUNTIME_FM_KEY)
            if not isinstance(raw_value, str):
                return {}
            # Legacy form: raw JSON (YAML already unwrapped its single-quoting, so
            # the value starts with `{`). New form: base64-encoded JSON. A present
            # but undecodable value is boxed as MALFORMED (not left to raise a bare
            # ValueError) so resolve() rejects it the same way it does bad YAML.
            try:
                if raw_value.lstrip().startswith("{"):
                    return json.loads(raw_value)
                return json.loads(base64.b64decode(raw_value).decode("utf-8"))
            except (ValueError, TypeError) as exc:
                raise RegistryRecordMalformedError(
                    f"SKILL.md {_SKILL_RUNTIME_FM_KEY} is not decodable base64/JSON: {exc}"
                ) from exc
        # MCP: JSON server.json with the runtime in a `_meta` block. A valid
        # server.json may carry a non-object `_meta` (or none); guard the shape so
        # `{"_meta": "x"}` does not raise an unboxed AttributeError — mirrors the
        # dict guard in extractPayload in agent-registry-client.ts (#837 review).
        inline = descriptors.get("mcpServer", {}).get("data") or "{}"
        body = _decode_descriptor_json(inline, "MCP server.json body")
        meta = body.get("_meta")
        if not isinstance(meta, dict):
            return {}
        return meta.get(_RUNTIME_META_KEY, {})

    def _list_records(self, kind: str, namespace: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        next_token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"registryId": self._registry_id, "maxResults": 50}
            if next_token:
                kwargs["nextToken"] = next_token
            page = self._client.list_registry_records(**kwargs)
            for summary in page.get("registryRecords", []) or []:
                dkind, dns, _ = self._decode_name(summary.get("name", ""))
                if dkind != kind or dns != namespace:
                    continue
                record_id = (
                    self._id_from_arn(summary["recordArn"])
                    if summary.get("recordArn")
                    else summary.get("recordId")
                )
                if not record_id:
                    continue
                full = self._client.get_registry_record(
                    registryId=self._registry_id, recordId=record_id
                )
                out.append(full)
            next_token = page.get("nextToken")
            if not next_token:
                break
        return out

    # --- port surface -----------------------------------------------------------

    def get_record(
        self, kind: str, namespace: str, name: str, version: str
    ) -> dict[str, Any] | None:
        for raw in self._list_records(kind, namespace):
            _, _, dname = self._decode_name(raw.get("name", ""))
            if dname == name and raw.get("recordVersion") == version:
                # Fail closed on the targeted record: a malformed descriptor erased
                # its publisher/runtime, so surface the parse failure (via
                # _extract_runtime) rather than hand back a record whose attribution
                # is silently gone. Mirrors getRecord in agent-registry-client.ts,
                # which throws RegistryRecordMalformedError for the same case (#791).
                # Called for its side effect: it raises if the descriptor is
                # malformed; the parsed value is discarded (get_record returns raw).
                _ = self._extract_runtime(raw)
                return raw
        return None

    def resolve(self, ref: ParsedRef) -> ResolvedAsset:
        ref_str = f"registry://{ref.kind}/{ref.namespace}/{ref.name}@{ref.constraint.raw}"
        records = self._list_records(ref.kind, ref.namespace)
        candidates = [
            r
            for r in records
            if self._decode_name(r.get("name", ""))[2] == ref.name
            and r.get("status") in _RESOLVABLE_STATUSES
        ]
        by_version = {r.get("recordVersion", ""): r for r in candidates}
        winning = select_highest(list(by_version.keys()), ref.constraint)
        if winning is None:
            raise RegistryResolutionError(
                "NO_MATCHING_VERSION",
                ref_str,
                f"no approved version of {ref.kind}/{ref.namespace}/{ref.name} "
                f"satisfies {ref.constraint.raw}",
            )
        winner = by_version[winning]
        # Fail closed: a resolvable record whose runtime payload is empty must NOT
        # resolve to {} — that would let a task load nothing while the audit claims
        # the pin was honored (REGISTRY.md §8). An out-of-band write can produce an
        # empty runtime; a corrupt descriptor is caught below as MALFORMED.
        try:
            runtime = self._extract_runtime(winner)
        except RegistryRecordMalformedError as exc:
            # Distinct from REMOVED: the descriptor (frontmatter, x-abca-runtime
            # value, or CUSTOM/MCP body) is present but unparseable, so its
            # attribution/runtime were erased — reject rather than trust `{}` (#791).
            # _extract_runtime boxes every parse/decode failure as this error, so
            # both languages classify a corrupt descriptor as MALFORMED (not REMOVED).
            # Keep the parser text (which can echo raw descriptor bytes) off the
            # message and on the exception chain (`from exc`) only — the TS twin
            # returns this reason on an open 422, so neither side leaks the payload
            # (#837 review).
            raise RegistryResolutionError(
                "MALFORMED",
                ref_str,
                f"resolved {ref.kind}/{ref.namespace}/{ref.name}@{winning} "
                f"has a malformed descriptor",
            ) from exc
        if not isinstance(runtime, dict) or not runtime:
            raise RegistryResolutionError(
                "REMOVED",
                ref_str,
                f"resolved {ref.kind}/{ref.namespace}/{ref.name}@{winning} "
                f"has no loadable runtime payload",
            )
        warnings = ["DEPRECATED"] if winner.get("status") == "DEPRECATED" else []
        return ResolvedAsset(
            kind=ref.kind,
            namespace=ref.namespace,
            name=ref.name,
            version=winning,
            runtime=runtime,
            warnings=warnings,
        )
