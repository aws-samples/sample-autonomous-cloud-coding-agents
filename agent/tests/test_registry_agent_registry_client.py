"""Unit tests for registry.agent_registry_client read-side extraction.

Focus: ``_extract_runtime`` must recover the runtime payload from all three
descriptor storage shapes — CUSTOM (verbatim JSON), MCP (JSON + ``_meta``), and
SKILL (Markdown frontmatter, runtime in ``x-abca-runtime``). The SKILL parse
must byte-match what the TS adapter writes (parity).
"""

from __future__ import annotations

import base64
import json

import pytest

from registry.agent_registry_client import AgentRegistryClient
from registry.client import RegistryRecordMalformedError, RegistryResolutionError
from registry.ref import parse_ref

_RUNTIME_META_KEY = "dev.abca.runtime"


def _client() -> AgentRegistryClient:
    return AgentRegistryClient("r", None)


# A descriptor level, or its `data`, that is an explicit null or not a mapping. Either
# way the payload is absent, not corrupt: the TS adapter reads every row as an empty
# runtime (`?.` and `??` in extractPayload), which resolve() then fails as REMOVED (#781).
_ABSENT_DESCRIPTORS = [
    pytest.param("CUSTOM", None, id="custom-descriptors-null"),
    pytest.param("CUSTOM", {"custom": None}, id="custom-custom-null"),
    pytest.param("CUSTOM", {"custom": {"data": None}}, id="custom-data-null"),
    pytest.param("CUSTOM", "text", id="custom-descriptors-text"),
    pytest.param("CUSTOM", {"custom": "text"}, id="custom-custom-text"),
    pytest.param("MCP", None, id="mcp-descriptors-null"),
    pytest.param("MCP", {"mcpServer": None}, id="mcp-mcpServer-null"),
    pytest.param("MCP", {"mcpServer": {"data": None}}, id="mcp-data-null"),
    pytest.param("MCP", {"mcpServer": ["x"]}, id="mcp-mcpServer-list"),
    pytest.param("SKILL", None, id="skill-descriptors-null"),
    pytest.param("SKILL", {"agentSkillsDefinition": None}, id="skill-agentSkillsDefinition-null"),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": None}},
        id="skill-additionalData-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": None}}},
        id="skill-skillMd-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": {"data": None}}}},
        id="skill-data-null",
    ),
    pytest.param(
        "SKILL",
        {"agentSkillsDefinition": {"additionalData": {"skillMd": "text"}}},
        id="skill-skillMd-text",
    ),
]


class _FakeBoto:
    """Minimal agent-registry-control stand-in: one page of records, and
    get_registry_record echoing the seeded record by id."""

    def __init__(self, records: list[dict]) -> None:
        self._records = records

    def list_registry_records(self, **_kwargs):
        return {"registryRecords": self._records, "nextToken": None}

    def get_registry_record(self, *, registryId, recordId):
        for r in self._records:
            if r.get("recordId") == recordId:
                return r
        return {}


class TestExtractRuntime:
    def test_custom_reads_body_runtime(self):
        runtime = {"cedar_text": "forbid(principal, action, resource);"}
        raw = {
            "recordType": "CUSTOM",
            "descriptors": {"custom": {"data": json.dumps({"runtime": runtime, "discovery": {}})}},
        }
        assert _client()._extract_runtime(raw) == runtime

    def test_mcp_reads_meta_block(self):
        runtime = {"type": "http", "url": "https://mcp.example.com/mcp"}
        server = {"name": "acme/x", "version": "1.0.0", "_meta": {_RUNTIME_META_KEY: runtime}}
        raw = {
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": json.dumps(server)}},
        }
        assert _client()._extract_runtime(raw) == runtime

    @staticmethod
    def _skill_md(runtime_line: str) -> dict:
        skill_md = (
            "---\n"
            "name: acme-readme-helper\n"
            "description: d\n"
            "version: 1.0.0\n"
            f"{runtime_line}\n"
            "---\n"
            "# acme/readme-helper\n"
            "body"
        )
        return {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }

    def test_agent_skills_parses_base64_frontmatter(self):
        # The shape the TS adapter's buildSkillMd emits: base64-encoded JSON.
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_base64_survives_apostrophe(self):
        # The exact payload that broke single-quoted YAML frontmatter (#246).
        runtime = {"prompt_fragment": "Don't skip tests; it's required.", "tool_hints": ["Don't"]}
        b64 = base64.b64encode(json.dumps(runtime).encode()).decode()
        assert _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {b64}")) == runtime

    def test_agent_skills_parses_legacy_single_quoted_json(self):
        # Records published before the base64 switch must still resolve.
        runtime = {"prompt_fragment": "Add a note.", "tool_hints": ["Edit"]}
        line = f"x-abca-runtime: '{json.dumps(runtime)}'"
        assert _client()._extract_runtime(self._skill_md(line)) == runtime

    def test_agent_skills_missing_frontmatter_key_returns_empty(self):
        skill_md = "---\nname: x\ndescription: d\nversion: 1.0.0\n---\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_malformed_frontmatter_raises_not_empty(self):
        # A frontmatter block that is present but not valid YAML (unterminated flow
        # sequence) must be rejected, not collapsed to `{}` — collapsing erases the
        # publisher/runtime and hides the corruption (#791).
        skill_md = "---\nname: x\nx-abca-runtime: [1, 2\n---\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_agent_skills_undecodable_runtime_raises_malformed(self):
        # Frontmatter parses as valid YAML, but x-abca-runtime base64-decodes to a
        # non-JSON string — must classify as MALFORMED (mirrors the TS adapter),
        # not collapse to {} or leak a bare ValueError (PR #837 review).
        bad = base64.b64encode(b"not json").decode()
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {bad}"))

    def test_custom_invalid_json_raises_malformed(self):
        raw = {"recordType": "CUSTOM", "descriptors": {"custom": {"data": "not json{"}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_mcp_invalid_json_raises_malformed(self):
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": "{bad json"}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize("data", ["null", "123", "[1, 2]", '"just a string"'])
    def test_custom_non_object_body_raises_malformed(self, data):
        # json.loads succeeds on these, then body.get would raise a bare
        # AttributeError — box it as MALFORMED, mirroring parseDescriptorJson's
        # object check in the TS adapter (#837 review).
        raw = {"recordType": "CUSTOM", "descriptors": {"custom": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize("data", ["null", "[1, 2]", '"s"'])
    def test_mcp_non_object_body_raises_malformed(self, data):
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_mcp_non_dict_meta_returns_empty_not_crash(self):
        # `{"_meta": "x"}`: `.get` on a str would raise AttributeError before the
        # #837 guard. Now it yields an empty runtime (resolve then fails REMOVED).
        server = {"name": "acme/x", "version": "1.0.0", "_meta": "not-a-dict"}
        raw = {"recordType": "MCP", "descriptors": {"mcpServer": {"data": json.dumps(server)}}}
        assert _client()._extract_runtime(raw) == {}

    def test_agent_skills_non_mapping_frontmatter_raises_malformed(self):
        # Frontmatter that is valid YAML but a sequence/scalar (not a mapping) must
        # reject as MALFORMED rather than collapse to `{}`, which would hide the
        # corruption the way an unparseable block would (#791 / #837 review).
        skill_md = "---\n- a\n- b\n---\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    def test_agent_skills_newline_description_cannot_inject_runtime_key(self):
        # B1 (#246): a description carrying a newline + a second x-abca-runtime
        # line must not shadow the validated runtime. Frontmatter emitted by the
        # safe builder quotes the description, so the injection stays a value.
        import yaml

        legit = {"prompt_fragment": "THE VALIDATED FRAGMENT"}
        injected = json.dumps({"prompt_fragment": "INJECTED"}).encode()
        injected_b64 = base64.b64encode(injected).decode()
        frontmatter = {
            "name": "acme-tdd",
            "description": f"benign\nx-abca-runtime: {injected_b64}",
            "version": "1.0.0",
            "x-abca-runtime": base64.b64encode(json.dumps(legit).encode()).decode(),
        }
        skill_md = "---\n" + yaml.dump(frontmatter).strip() + "\n---\n# acme/tdd\nbody"
        raw = {
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
        }
        assert _client()._extract_runtime(raw) == legit

    @pytest.mark.parametrize(("record_type", "descriptors"), _ABSENT_DESCRIPTORS)
    def test_absent_descriptor_reads_as_an_empty_payload(self, record_type, descriptors):
        raw = {"recordType": record_type, "descriptors": descriptors}
        assert _client()._extract_runtime(raw) == {}

    @pytest.mark.parametrize(
        ("record_type", "descriptor"), [("CUSTOM", "custom"), ("MCP", "mcpServer")]
    )
    @pytest.mark.parametrize(
        "data",
        [
            pytest.param("", id="empty-string"),
            pytest.param(0, id="zero"),
            pytest.param(False, id="false"),
        ],
    )
    def test_body_that_is_not_json_text_raises_malformed(self, record_type, descriptor, data):
        # Present, unlike a null, so not an absent payload: the TS adapter's `??` stands
        # in for null and undefined only. An empty string, 0 and false reach its parser,
        # and none of them parses to a JSON object, for both record types.
        raw = {"recordType": record_type, "descriptors": {descriptor: {"data": data}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize(
        ("record_type", "descriptor", "body"),
        [
            pytest.param("CUSTOM", "custom", '{"runtime": {"limit": NaN}}', id="custom"),
            pytest.param(
                "MCP",
                "mcpServer",
                '{"_meta": {"dev.abca.runtime": {"limit": Infinity}}}',
                id="mcp",
            ),
        ],
    )
    def test_non_json_number_in_body_raises_malformed(self, record_type, descriptor, body):
        # NaN, Infinity and -Infinity are not JSON: JSON.parse in the TS adapter rejects
        # a body that holds one. json.loads reads them unless told otherwise, and the
        # record would resolve here while the API side reports it MALFORMED.
        raw = {"recordType": record_type, "descriptors": {descriptor: {"data": body}}}
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(raw)

    @pytest.mark.parametrize(
        "value",
        [
            pytest.param(base64.b64encode(b'{"limit": -Infinity}').decode(), id="base64"),
            pytest.param("""'{"limit": NaN}'""", id="legacy-json"),
        ],
    )
    def test_agent_skills_non_json_number_in_runtime_raises_malformed(self, value):
        # The same for a SKILL.md runtime, in its base64 form and in the legacy
        # single-quoted JSON one: each goes through its own json.loads call.
        with pytest.raises(RegistryRecordMalformedError):
            _client()._extract_runtime(self._skill_md(f"x-abca-runtime: {value}"))

    def test_agent_skills_duplicate_frontmatter_key_last_value_wins(self):
        # Hand-written frontmatter that repeats the runtime key. PyYAML keeps the last
        # value, and so does js-yaml under `json: true` (parseSkillFrontmatter in
        # agent-registry-client.ts): the two readers must agree on which runtime such
        # a record carries. Neither rejects it. What keeps a second key from being
        # smuggled in is the writer, which quotes every value.
        def b64(runtime: dict) -> str:
            return base64.b64encode(json.dumps(runtime).encode()).decode()

        first = b64({"prompt_fragment": "FIRST"})
        second = b64({"prompt_fragment": "SECOND"})
        raw = self._skill_md(f"x-abca-runtime: {first}\nx-abca-runtime: {second}")
        assert _client()._extract_runtime(raw) == {"prompt_fragment": "SECOND"}


class TestResolveFailClosed:
    """resolve() must never hand back a record with an empty/unreadable runtime —
    that would let a task run with a missing/substituted asset (REGISTRY.md §8)."""

    @staticmethod
    def _mcp_record(version: str, status: str, *, with_runtime: bool) -> dict:
        server: dict = {"name": "acme/pdf-tools", "version": version}
        if with_runtime:
            server["_meta"] = {_RUNTIME_META_KEY: {"type": "http", "url": "https://x"}}
        return {
            "recordId": f"rec-{version}",
            "recordArn": (
                f"arn:aws:agent-registry:us-east-1:123456789012:registry/r/record/rec-{version}"
            ),
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": json.dumps(server)}},
            "recordVersion": version,
            "status": status,
        }

    def _resolve(self, records: list[dict], ref_str: str):
        client = AgentRegistryClient("r", _FakeBoto(records))
        return client.resolve(parse_ref(ref_str))

    def test_resolves_when_runtime_present(self):
        asset = self._resolve(
            [self._mcp_record("1.4.1", "APPROVED", with_runtime=True)],
            "registry://mcp_server/acme/pdf-tools@1.4.1",
        )
        assert asset.version == "1.4.1"
        assert asset.runtime == {"type": "http", "url": "https://x"}

    def test_fails_closed_when_approved_record_has_empty_runtime(self):
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(
                [self._mcp_record("1.4.1", "APPROVED", with_runtime=False)],
                "registry://mcp_server/acme/pdf-tools@1.4.1",
            )
        assert exc.value.reason == "REMOVED"

    def test_fails_malformed_when_winner_frontmatter_is_unparseable(self):
        # A malformed frontmatter block must reject the ref as MALFORMED — distinct
        # from REMOVED (empty) — rather than resolving with erased attribution (#791).
        skill_md = "---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "recordArn": (
                "arn:aws:agent-registry:us-east-1:123456789012:registry/r/record/rec-1.0.0"
            ),
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://skill/acme/readme-helper@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_runtime_value_undecodable(self):
        # Valid YAML frontmatter but an undecodable x-abca-runtime value must be
        # MALFORMED, not REMOVED — matching the TS adapter (PR #837 review).
        bad = base64.b64encode(b"not json").decode()
        skill_md = f"---\nname: acme-readme-helper\nx-abca-runtime: {bad}\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://skill/acme/readme-helper@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_custom_body_invalid(self):
        record = {
            "recordId": "rec-1.0.0",
            "name": "cedar_policy_module/acme/permit",
            "recordType": "CUSTOM",
            "descriptors": {"custom": {"data": "not json{"}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://cedar_policy_module/acme/permit@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_fails_malformed_when_mcp_body_invalid(self):
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": "{bad json"}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_get_record_fails_closed_on_malformed_target(self):
        # Parity with TS getRecord, which throws for a malformed target rather than
        # handing back a record whose attribution was silently erased (#791).
        skill_md = "---\nname: acme-readme-helper\nx-abca-runtime: [1, 2\n---\nbody"
        record = {
            "recordId": "rec-1.0.0",
            "name": "skill/acme/readme-helper",
            "recordType": "SKILL",
            "descriptors": {
                "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
            },
            "recordVersion": "1.0.0",
            "status": "DRAFT",
        }
        client = AgentRegistryClient("r", _FakeBoto([record]))
        with pytest.raises(RegistryRecordMalformedError):
            client.get_record("skill", "acme", "readme-helper", "1.0.0")

    def test_rejects_malformed_winner_rather_than_downgrading(self):
        # The TS adapter's highest-value test, mirrored: a valid lower version
        # exists but the highest matching version is malformed. Silently resolving
        # the lower one would mask that the pinned (winning) version is corrupt —
        # reject as MALFORMED instead (#791 / #837 review).
        def _skill(version: str, runtime_line: str) -> dict:
            skill_md = f"---\nname: acme-readme-helper\n{runtime_line}\n---\nbody"
            return {
                "recordId": f"rec-{version}",
                "name": "skill/acme/readme-helper",
                "recordType": "SKILL",
                "descriptors": {
                    "agentSkillsDefinition": {"additionalData": {"skillMd": {"data": skill_md}}}
                },
                "recordVersion": version,
                "status": "APPROVED",
            }

        good = base64.b64encode(json.dumps({"prompt_fragment": "ok"}).encode()).decode()
        records = [
            _skill("1.0.0", f"x-abca-runtime: {good}"),
            _skill("1.1.0", "x-abca-runtime: [1, 2"),  # highest, but unparseable
        ]
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(records, "registry://skill/acme/readme-helper@^1.0.0")
        assert exc.value.reason == "MALFORMED"

    def test_malformed_message_does_not_leak_descriptor_bytes(self):
        # resolve() returns this reason on an open 422 (via the TS twin); the raw
        # parser text — which can echo descriptor bytes — must stay off the message
        # and only on __cause__ (#837 review).
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": "MCP",
            "descriptors": {"mcpServer": {"data": '{"_meta": SUPERSECRETTOKEN'}},
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")
        assert "SUPERSECRETTOKEN" not in str(exc.value)

    def _resolve_payload(self, record_type: str, descriptors: object):
        # The reader goes by the record type, so one name serves every payload.
        record = {
            "recordId": "rec-1.0.0",
            "name": "mcp_server/acme/pdf-tools",
            "recordType": record_type,
            "descriptors": descriptors,
            "recordVersion": "1.0.0",
            "status": "APPROVED",
        }
        return self._resolve([record], "registry://mcp_server/acme/pdf-tools@1.0.0")

    @pytest.mark.parametrize(("record_type", "descriptors"), _ABSENT_DESCRIPTORS)
    def test_fails_removed_when_a_descriptor_level_is_absent(self, record_type, descriptors):
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve_payload(record_type, descriptors)
        assert exc.value.reason == "REMOVED"

    @pytest.mark.parametrize(
        ("record_type", "descriptors"),
        [
            pytest.param("CUSTOM", {"custom": {"data": '{"runtime": null}'}}, id="custom-runtime"),
            pytest.param("MCP", {"mcpServer": {"data": '{"_meta": null}'}}, id="mcp-meta"),
            pytest.param(
                "MCP",
                {"mcpServer": {"data": '{"_meta": {"dev.abca.runtime": null}}'}},
                id="mcp-meta-runtime",
            ),
        ],
    )
    def test_fails_removed_when_the_body_holds_a_null_runtime(self, record_type, descriptors):
        # The body parses and the null sits where the runtime should be: nothing to load.
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve_payload(record_type, descriptors)
        assert exc.value.reason == "REMOVED"

    def test_get_record_returns_a_record_whose_descriptor_level_is_null(self):
        # Parity with TS getRecord: a null payload makes an empty record, not a
        # malformed one, so the lookup hands the record back instead of raising.
        record = {
            "recordId": "rec-1.0.0",
            "name": "cedar_policy_module/acme/permit",
            "recordType": "CUSTOM",
            "descriptors": {"custom": None},
            "recordVersion": "1.0.0",
            "status": "DRAFT",
        }
        client = AgentRegistryClient("r", _FakeBoto([record]))
        assert client.get_record("cedar_policy_module", "acme", "permit", "1.0.0") is record

    def test_resolves_beside_unrelated_corrupt_records(self):
        # Corrupt records of another asset and of a lower version of this asset share
        # the namespace. Only the winner's payload is read, so neither stands in the
        # way of the healthy record.
        def _mcp(record_id: str, name: str, version: str, data: str) -> dict:
            return {
                "recordId": record_id,
                "name": f"mcp_server/acme/{name}",
                "recordType": "MCP",
                "descriptors": {"mcpServer": {"data": data}},
                "recordVersion": version,
                "status": "APPROVED",
            }

        healthy = json.dumps({"_meta": {_RUNTIME_META_KEY: {"type": "http", "url": "https://x"}}})
        asset = self._resolve(
            [
                _mcp("rec-other", "other", "1.0.0", "{bad json"),
                _mcp("rec-lower", "pdf-tools", "1.0.0", "{bad json"),
                _mcp("rec-healthy", "pdf-tools", "1.1.0", healthy),
            ],
            "registry://mcp_server/acme/pdf-tools@^1.0.0",
        )
        assert asset.version == "1.1.0"

    def test_unknown_status_is_not_a_resolution_candidate(self):
        # A status this code has never seen (the service can add one) is treated like
        # every status other than APPROVED and DEPRECATED: the record does not
        # resolve, and it does not hide a lower approved version.
        records = [
            self._mcp_record("1.0.0", "APPROVED", with_runtime=True),
            self._mcp_record("1.1.0", "SOME_FUTURE_STATUS", with_runtime=True),
        ]
        asset = self._resolve(records, "registry://mcp_server/acme/pdf-tools@^1.0.0")
        assert asset.version == "1.0.0"
        with pytest.raises(RegistryResolutionError) as exc:
            self._resolve(records, "registry://mcp_server/acme/pdf-tools@1.1.0")
        assert exc.value.reason == "NO_MATCHING_VERSION"

    def test_a_record_without_a_name_does_not_stop_the_others(self):
        # A null name decodes to no coordinates, as in the TS adapter (`?? ''`): the
        # record belongs to no asset, and the healthy one listed after it is found.
        nameless = {**self._mcp_record("2.0.0", "APPROVED", with_runtime=True), "name": None}
        healthy = self._mcp_record("1.0.0", "APPROVED", with_runtime=True)
        client = AgentRegistryClient("r", _FakeBoto([nameless, healthy]))
        asset = client.resolve(parse_ref("registry://mcp_server/acme/pdf-tools@^1.0.0"))
        assert asset.version == "1.0.0"
        assert client.get_record("mcp_server", "acme", "pdf-tools", "1.0.0") is healthy

    def test_a_record_without_a_version_does_not_stop_its_siblings(self):
        # A null recordVersion is no version (`?? ''` in the TS adapter): the record
        # cannot win, and the versions beside it still resolve.
        versionless = {
            **self._mcp_record("1.1.0", "APPROVED", with_runtime=True),
            "recordVersion": None,
        }
        records = [versionless, self._mcp_record("1.0.0", "APPROVED", with_runtime=True)]
        asset = self._resolve(records, "registry://mcp_server/acme/pdf-tools@^1.0.0")
        assert asset.version == "1.0.0"
