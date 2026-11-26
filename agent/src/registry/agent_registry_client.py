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
_NAME_MIN_PARTS = 2
_RUNTIME_META_KEY = "dev.abca.runtime"
_SKILL_RUNTIME_FM_KEY = "x-abca-runtime"
_SKILL_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
_RESOLVABLE_STATUSES = ("APPROVED", "DEPRECATED")


def _json_loads(data: str) -> Any:
    """``json.loads`` left alone also reads ``NaN``, ``Infinity`` and ``-Infinity``,
    which are not JSON and which ``JSON.parse`` rejects."""

    def reject(literal: str) -> Any:
        raise ValueError(f"{literal} is not a JSON value")

    return json.loads(data, parse_constant=reject)


def _decode_descriptor_json(data: str, what: str) -> dict[str, Any]:
    try:
        parsed = _json_loads(data)
    except (ValueError, TypeError) as exc:
        raise RegistryRecordMalformedError(f"{what} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RegistryRecordMalformedError(f"{what} is not a JSON object")
    return parsed


def _descriptor_text(descriptors: Any, *path: str, default: str) -> Any:
    node = descriptors
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return default if node is None else node


class AgentRegistryClient:
    def __init__(self, registry_id: str, client: Any) -> None:
        self._registry_id = registry_id
        self._client = client

    @staticmethod
    def _decode_name(record_name: str | None) -> tuple[str, str, str]:
        parts = (record_name or "").split(_NAME_SEP)
        kind = parts[0] if parts else ""
        namespace = parts[1] if len(parts) > 1 else ""
        name = _NAME_SEP.join(parts[_NAME_MIN_PARTS:]) if len(parts) > _NAME_MIN_PARTS else ""
        return kind, namespace, name

    @staticmethod
    def _id_from_arn(arn: str) -> str:
        return arn.split("/")[-1] if "/" in arn else arn

    def _extract_runtime(self, raw: dict[str, Any]) -> dict[str, Any]:
        descriptors = raw.get("descriptors")
        record_type = raw.get("recordType")
        if record_type == "CUSTOM":
            body = _decode_descriptor_json(
                _descriptor_text(descriptors, "custom", "data", default="{}"),
                "CUSTOM record body",
            )
            return body.get("runtime", {})
        if record_type == "SKILL":
            skill_md = _descriptor_text(
                descriptors,
                "agentSkillsDefinition",
                "additionalData",
                "skillMd",
                "data",
                default="",
            )
            m = _SKILL_FRONTMATTER_RE.search(skill_md)
            if not m:
                return {}
            try:
                fm = yaml.safe_load(m.group(1))
            except yaml.YAMLError as exc:
                raise RegistryRecordMalformedError(
                    f"SKILL.md frontmatter is not valid YAML: {exc}"
                ) from exc
            # An empty block (``---\n\n---``) parses to None.
            if fm is None:
                return {}
            if not isinstance(fm, dict):
                raise RegistryRecordMalformedError("SKILL.md frontmatter is not a mapping")
            raw_value = fm.get(_SKILL_RUNTIME_FM_KEY)
            if not isinstance(raw_value, str):
                return {}
            try:
                if raw_value.lstrip().startswith("{"):
                    return _json_loads(raw_value)
                return _json_loads(base64.b64decode(raw_value).decode("utf-8"))
            except (ValueError, TypeError) as exc:
                raise RegistryRecordMalformedError(
                    f"SKILL.md {_SKILL_RUNTIME_FM_KEY} is not decodable base64/JSON: {exc}"
                ) from exc
        inline = _descriptor_text(descriptors, "mcpServer", "data", default="{}")
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

    def get_record(
        self, kind: str, namespace: str, name: str, version: str
    ) -> dict[str, Any] | None:
        for raw in self._list_records(kind, namespace):
            _, _, dname = self._decode_name(raw.get("name", ""))
            if dname == name and raw.get("recordVersion") == version:
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
        by_version = {r.get("recordVersion") or "": r for r in candidates}
        winning = select_highest(list(by_version.keys()), ref.constraint)
        if winning is None:
            raise RegistryResolutionError(
                "NO_MATCHING_VERSION",
                ref_str,
                f"no approved version of {ref.kind}/{ref.namespace}/{ref.name} "
                f"satisfies {ref.constraint.raw}",
            )
        winner = by_version[winning]
        try:
            runtime = self._extract_runtime(winner)
        except RegistryRecordMalformedError as exc:
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
