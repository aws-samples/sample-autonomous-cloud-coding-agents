"""Tests for the stuck/runaway guard (K7, live-caught ABCA-483)."""

from __future__ import annotations

from stuck_guard import (
    BAIL_THRESHOLD,
    STEER_THRESHOLD,
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
        # Conservative: unknown response must not be punished as a failure.
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
        # the offending command is previewed
        assert "mise //cdk:test" in action.message.lower()

    def test_steers_at_most_once_per_signature(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "steer"
        # same signature fails again but below bail → no second steer
        g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_bails_after_persistent_failure(self):
        g = StuckGuard()
        for _ in range(BAIL_THRESHOLD):
            g.record_tool_result("Bash", CMD, OOM)
        action = g.evaluate()
        assert action.kind == "bail"
        assert "Stuck" in action.message

    def test_success_resets_the_streak(self):
        g = StuckGuard()
        for _ in range(STEER_THRESHOLD - 1):
            g.record_tool_result("Bash", CMD, OOM)
        g.record_tool_result("Bash", CMD, OK)  # fixed it
        assert g.evaluate().kind == "none"
        # one more failure is a fresh streak, not at threshold
        g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_different_failing_commands_do_not_aggregate(self):
        # Two distinct commands each failing once → no trip (not the SAME loop).
        g = StuckGuard()
        g.record_tool_result("Bash", {"command": "a"}, OOM)
        g.record_tool_result("Bash", {"command": "b"}, OOM)
        g.record_tool_result("Bash", {"command": "c"}, OOM)
        assert g.evaluate().kind == "none"

    def test_healthy_varied_work_never_trips(self):
        # A large task: many different succeeding calls → never stuck.
        g = StuckGuard()
        for i in range(50):
            g.record_tool_result("Bash", {"command": f"step-{i}"}, OK)
        assert g.evaluate().kind == "none"

    def test_interleaved_success_on_OTHER_sig_does_not_clear_the_loop(self):
        # The real loop (cmd A) keeps failing; occasional unrelated success (cmd B)
        # must NOT mask it.
        g = StuckGuard()
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        g.record_tool_result("Bash", {"command": "other"}, OK)
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        g.record_tool_result("Bash", {"command": "other"}, OK)
        g.record_tool_result("Bash", {"command": "loop"}, OOM)
        action = g.evaluate()
        assert action.kind == "steer"
        assert "loop" in action.message.lower()
