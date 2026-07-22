"""Tests for the stuck/runaway guard (K7, live-caught ABCA-483)."""

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
        # same signature keeps failing identically → still only ONE steer, never
        # escalates to a kill (advisory-only by design — no bail).
        for _ in range(10):
            g.record_tool_result("Bash", CMD, OOM)
        assert g.evaluate().kind == "none"

    def test_never_bails_advisory_only(self):
        # Even on a persistent identical-failure spin, the guard NEVER returns
        # 'bail' — it only ever steers (once). The max_turns cap is the real
        # runaway backstop; a false positive here must cost at most one nudge.
        g = StuckGuard()
        for _ in range(20):
            g.record_tool_result("Bash", CMD, OOM)
        # The only non-'none' action this guard can ever produce is 'steer'.
        assert g.evaluate().kind in ("none", "steer")
        # And specifically it is not 'bail'.
        assert g.evaluate().kind != "bail"

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

    def test_iterating_agent_same_command_DIFFERENT_failures_never_steers(self):
        # K10 false-positive guard: the agent re-runs the SAME test command as
        # it fixes failures one by one — each run fails on a DIFFERENT test.
        # That's progress, not a loop. The streak resets on each new output, so
        # it never even reaches the (advisory) steer threshold.
        g = StuckGuard()
        cmd = {"command": "mise //cdk:test"}
        for i in range(STEER_THRESHOLD + 6):
            # A different failing test each run → different output → distinct streak.
            resp = f"FAIL test/file_{i}.test.ts:{i * 7} — expected {i} got {i + 1}\nexit code 1"
            g.record_tool_result("Bash", cmd, resp)
        action = g.evaluate()
        assert action.kind == "none", f"iterating agent should get no action, got {action.kind}"

    def test_same_command_IDENTICAL_failure_steers(self):
        # The genuine spin: same command, byte-identical failure output every
        # time → reaches the steer threshold and emits the one advisory nudge.
        g = StuckGuard()
        cmd = {"command": "mise //cdk:test"}
        for _ in range(STEER_THRESHOLD):
            g.record_tool_result("Bash", cmd, OOM)  # identical output each run
        assert g.evaluate().kind == "steer"

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


# DIFFERENT command each turn (distinct signatures, so no per-signature streak
# grows) but the SAME recurring error — exactly the 662 push-auth thrash: the
# agent retried the push every which way, each getting 'invalid credentials'.
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
    """ABCA-662: the loop-of-VARIATIONS the per-signature streak can't see — the
    agent tries a different command each turn toward the same failing goal (a git
    push that keeps failing on 'invalid credentials'). No single signature reaches
    STEER_THRESHOLD, but the trailing window is failure-dominated."""

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
        # A subsequent failing turn must not re-steer the window.
        g.record_tool_result("Bash", {"command": "git push again"}, _ERR)
        assert g.evaluate().kind == "none"

    def test_recent_failure_summary_names_the_last_failure(self):
        g = StuckGuard()
        for cmd, out in _PUSH_FAILS:
            g.record_tool_result("Bash", cmd, out)
        summary = g.recent_failure_summary()
        assert summary is not None
        # Neutral observation only — names WHAT repeated, makes no causal claim.
        assert "last tool calls repeated" in summary
        assert "spinning" not in summary  # must not editorialize
        assert "git push --force-with-lease" in summary  # most recent failing command
        assert "invalid credentials" in summary  # the recurring error detail

    def test_no_summary_when_window_is_mostly_successful(self):
        # A productive agent (varied commands, mostly succeeding) must yield no
        # summary — so its max_turns reason stays unchanged.
        g = StuckGuard()
        for i in range(6):
            g.record_tool_result("Bash", {"command": f"step {i}"}, OK)
        assert g.recent_failure_summary() is None
        assert g.evaluate().kind == "none"

    def test_healthy_iteration_below_window_threshold_no_steer(self):
        # 4/6 failing is below WINDOW_FAIL_THRESHOLD(5) — a normal fix-iterate loop
        # (some fail, some pass) must NOT trip the window steer.
        g = StuckGuard()
        outcomes = [OOM, OK, OOM, OK, OOM, OOM]  # 4 fails / 6
        for i, out in enumerate(outcomes):
            g.record_tool_result("Bash", {"command": f"cmd {i}"}, out)
        assert g.evaluate().kind == "none"
        assert g.recent_failure_summary() is None

    def test_window_steers_at_exactly_the_threshold(self):
        # N4 boundary: exactly WINDOW_FAIL_THRESHOLD (5) same-fingerprint failures
        # in a FULL window of WINDOW (6) — the `>=` edge where an off-by-one would
        # hide. One OK dilutes the window to 5/6 fails, still == the threshold.
        assert WINDOW == 6 and WINDOW_FAIL_THRESHOLD == 5  # pin the constants
        g = StuckGuard()
        outcomes = [OK, _ERR, _ERR, _ERR, _ERR, _ERR]  # 5 same-fp fails / full 6
        for i, out in enumerate(outcomes):
            g.record_tool_result("Bash", {"command": f"push {i}"}, out)
        action = g.evaluate()
        assert action.kind == "steer"
        assert action.signature == "__window__"
        assert g.recent_failure_summary() is not None

    def test_no_steer_when_window_not_yet_full(self):
        # N4 boundary: WINDOW_FAIL_THRESHOLD failures but the window has fewer than
        # WINDOW entries — _dominant_window_failure requires a FULL window, so 5
        # identical failures in a length-5 history must NOT steer yet.
        g = StuckGuard()
        for i in range(WINDOW_FAIL_THRESHOLD):  # 5 fails, window not yet at 6
            g.record_tool_result("Bash", {"command": f"push {i}"}, _ERR)
        assert g.evaluate().kind == "none"
        assert g.recent_failure_summary() is None
