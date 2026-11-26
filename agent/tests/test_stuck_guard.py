from __future__ import annotations

from stuck_guard import (
    STEER_THRESHOLD,
    WINDOW,
    WINDOW_FAIL_THRESHOLD,
    StuckGuard,
    _looks_failed,
    _signature,
)

OOM = "[//cdk:test] FAILED (exit 134)\n<--- Last few GCs --->\nJavaScript heap out of memory"
OK = "Tests passed. 2813 passed."
CMD = {"command": "MISE_EXPERIMENTAL=1 mise //cdk:test"}


class TestFailureDetection:
    def test_oom_exit_134_is_failure(self):
        assert _looks_failed(OOM) is True

    def test_command_not_found_is_failure(self):
        assert _looks_failed("bash: line 1: yarn: command not found") is True

    def test_clean_output_is_not_failure(self):
        assert _looks_failed(OK) is False

    def test_exit_zero_is_not_failure(self):
        assert _looks_failed("done (exit 0)") is False

    def test_unrecognized_output_is_not_failure(self):
        assert _looks_failed("here is the file content you asked for") is False

    def test_empty_is_not_failure(self):
        assert _looks_failed("") is False


class TestSignature:
    def test_bash_keys_on_command_whitespace_collapsed(self):
        a = _signature("Bash", {"command": "mise   //cdk:test"})
        b = _signature("Bash", {"command": "mise //cdk:test"})
        assert a == b

    def test_different_commands_differ(self):
        a = _signature("Bash", {"command": "yarn test"})
        b = _signature("Bash", {"command": "yarn build"})
        assert a != b

    def test_edit_keys_on_file_path(self):
        a = _signature("Edit", {"file_path": "src/x.ts"})
        b = _signature("Edit", {"file_path": "src/x.ts"})
        assert a == b

    def test_a_tool_without_command_or_path_keys_on_its_whole_input(self):
        a = _signature("WebFetch", {"url": "https://a.example", "prompt": "summarise"})
        b = _signature("WebFetch", {"url": "https://b.example", "prompt": "summarise"})
        assert a != b
        assert a == _signature("WebFetch", {"prompt": "summarise", "url": "https://a.example"})


class TestOutcomeGivenByTheCaller:
    SCRIPT = "#!/bin/bash\nif ! command -v yarn; then\n  exit 1\nfi\n"

    def test_a_call_given_as_completed_is_no_failure_whatever_its_output_says(self):
        g = StuckGuard()
        for _ in range(WINDOW):
            g.record_tool_result(
                "Read", {"file_path": "scripts/build.sh"}, self.SCRIPT, failed=False
            )
        assert g.evaluate().kind == "none"
        assert g.recent_failure_summary() is None

    def test_a_call_given_as_failed_counts_without_a_marker_in_its_text(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result(
                "Read", {"file_path": "a.txt"}, "File does not exist.", failed=True
            )
        assert g.evaluate().kind == "steer"

    def test_without_an_outcome_the_text_decides(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Read", {"file_path": "scripts/build.sh"}, self.SCRIPT)
        assert g.evaluate().kind == "steer"


class TestStuckGuardLifecycle:
    def test_no_action_below_steer_threshold(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD - 1):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_steers_at_threshold(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Bash", CMD, OOM)
        action = g.evaluate()
        assert action.kind == "steer"
        assert "STOP retrying" in action.message
        assert "mise //cdk:test" in action.message.lower()

    def test_steers_at_most_once_per_signature(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "steer"
        for _ in range(10):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_never_bails_advisory_only(self):
        g = StuckGuard()
        for _ in range(20):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind in ("none", "steer")
        assert g.evaluate().kind != "bail"

    def test_success_resets_the_streak(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD - 1):
            g.record_tool_result("Bash", CMD, OOM)
        g.record_tool_result("Bash", CMD, OK)
        assert g.evaluate().kind == "none"
        g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_different_failing_commands_do_not_aggregate(self):
        g = StuckGuard()
        g.record_tool_result("Bash", {"command": "a"}, OOM)
        g.record_tool_result("Bash", {"command": "b"}, OOM)
        g.record_tool_result("Bash", {"command": "c"}, OOM)
        assert g.evaluate().kind == "none"

    def test_same_failure_for_different_inputs_of_one_tool_is_not_one_command(self):
        g = StuckGuard()
        for host in ("a", "b", "c"):
            g.record_tool_result(
                "WebFetch", {"url": f"https://{host}.example"}, "fatal: unable to fetch"
            )
        assert g.evaluate().kind == "none"

    def test_healthy_varied_work_never_trips(self):
        g = StuckGuard()
        for i in range(50):
            g.record_tool_result("Bash", {"command": f"step-{i}"}, OK)
        assert g.evaluate().kind == "none"

    def test_iterating_agent_same_command_DIFFERENT_failures_never_steers(self):
        g = StuckGuard()
        cmd = {"command": "mise //cdk:test"}
        for i in range(STEER_THRESHOLD + 6):
            resp = f"FAIL test/file_{i}.test.ts:{i * 7} — expected {i} got {i + 1}\nexit code 1"
            g.record_tool_result("Bash", cmd, resp)
        action = g.evaluate()
        assert action.kind == "none", f"iterating agent should get no action, got {action.kind}"

    def test_same_command_IDENTICAL_failure_steers(self):
        g = StuckGuard()
        cmd = {"command": "mise //cdk:test"}
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Bash", cmd, OOM)
        assert g.evaluate().kind == "steer"

    def test_interleaved_success_on_OTHER_sig_does_not_clear_the_loop(self):
        g = StuckGuard()
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        g.record_tool_result("Bash", {"command": "other"}, OK)
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        g.record_tool_result("Bash", {"command": "other"}, OK)
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        action = g.evaluate()
        assert action.kind == "steer"
        assert "loop" in action.message.lower()


_ERR = "remote: invalid credentials\nfatal: exit 128"
_PUSH_FAILS = [
    ({"command": "git push origin HEAD"}, _ERR),
    ({"command": "git config http.extraheader ... && git push"}, _ERR),
    ({"command": "git remote set-url origin https://x-access-token@... && git push"}, _ERR),
    ({"command": "GITHUB_TOKEN=$GH_TOKEN git push"}, _ERR),
    ({"command": "git -c credential.helper= push"}, _ERR),
    ({"command": "git push --force-with-lease"}, _ERR),
]


class TestWindowSpin:
    def test_window_steers_on_loop_of_distinct_failing_commands(self):
        g = StuckGuard()
        for cmd, out in _PUSH_FAILS:
            g.record_tool_result("Bash", cmd, out)
        action = g.evaluate()
        assert action.kind == "steer"
        assert action.signature == "__window__"
        assert "spinning" in action.message.lower()

    def test_window_steer_fires_at_most_once(self):
        g = StuckGuard()
        for cmd, out in _PUSH_FAILS:
            g.record_tool_result("Bash", cmd, out)
        assert g.evaluate().kind == "steer"
        g.record_tool_result("Bash", {"command": "git push again"}, _ERR)
        assert g.evaluate().kind == "none"

    def test_recent_failure_summary_names_the_last_failure(self):
        g = StuckGuard()
        for cmd, out in _PUSH_FAILS:
            g.record_tool_result("Bash", cmd, out)
        summary = g.recent_failure_summary()
        assert summary is not None
        assert "last tool calls repeated" in summary
        assert "spinning" not in summary
        assert "git push --force-with-lease" in summary
        assert "invalid credentials" in summary

    def test_no_summary_when_window_is_mostly_successful(self):
        g = StuckGuard()
        for i in range(6):
            g.record_tool_result("Bash", {"command": f"step {i}"}, OK)
        assert g.recent_failure_summary() is None
        assert g.evaluate().kind == "none"

    def test_healthy_iteration_below_window_threshold_no_steer(self):
        g = StuckGuard()
        outcomes = [OOM, OK, OOM, OK, OOM, OOM]
        for i, out in enumerate(outcomes):
            g.record_tool_result("Bash", {"command": f"cmd {i}"}, out)
        assert g.evaluate().kind == "none"
        assert g.recent_failure_summary() is None

    def test_window_steers_at_exactly_the_threshold(self):
        assert WINDOW == 6 and WINDOW_FAIL_THRESHOLD == 5
        g = StuckGuard()
        outcomes = [OK, _ERR, _ERR, _ERR, _ERR, _ERR]
        for i, out in enumerate(outcomes):
            g.record_tool_result("Bash", {"command": f"push {i}"}, out)
        action = g.evaluate()
        assert action.kind == "steer"
        assert action.signature == "__window__"
        assert g.recent_failure_summary() is not None

    def test_no_steer_when_window_not_yet_full(self):
        g = StuckGuard()
        for i in range(WINDOW_FAIL_THRESHOLD):
            g.record_tool_result("Bash", {"command": f"push {i}"}, _ERR)
        assert g.evaluate().kind == "none"
        assert g.recent_failure_summary() is None
