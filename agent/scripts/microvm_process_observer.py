"""Temporary image diagnostic: observe the agent server without opening sockets.

Run as the parent of the normal image command, after ``--``. This changes the
process tree and is diagnostic instrumentation, not a production entry point.
Only process state, port-8080 listener metadata, and cgroup memory counters are
recorded. Arguments, environment, request bodies and credentials are not logged.
"""

import argparse
import contextlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

_TCP_FIELDS_THROUGH_INODE = 10
_REPORT_INTERVAL_S = 5


def emit(event: str, **fields: Any) -> None:
    print(
        json.dumps(
            {
                "probe": "microvm-process-observer",
                "event": event,
                "wall_time_ns": time.time_ns(),
                "monotonic_ns": time.monotonic_ns(),
                "observer_pid": os.getpid(),
                **fields,
            }
        ),
        flush=True,
    )


def snapshot(pid: int) -> dict[str, Any]:
    result: dict[str, Any] = {"child_pid": pid}
    try:
        status = Path(f"/proc/{pid}/status").read_text()
        allowed = {"State", "Threads", "VmRSS", "SigPnd", "ShdPnd"}
        result["child_status"] = {
            key: value.strip()
            for line in status.splitlines()
            for key, _, value in [line.partition(":")]
            if key in allowed
        }
    except OSError as error:
        result["child_status_error"] = type(error).__name__
    listeners = []
    for family in ("tcp", "tcp6"):
        try:
            for line in Path(f"/proc/net/{family}").read_text().splitlines()[1:]:
                fields = line.split()
                if (
                    len(fields) >= _TCP_FIELDS_THROUGH_INODE
                    and fields[1].endswith(":1F90")
                    and fields[3] == "0A"
                ):
                    listeners.append({"family": family, "inode": fields[9]})
        except OSError as error:
            result[f"{family}_error"] = type(error).__name__
    result["listeners_8080"] = listeners
    try:
        inodes = {
            os.readlink(entry)
            for entry in Path(f"/proc/{pid}/fd").iterdir()
            if entry.name.isdigit()
        }
        result["child_owns_listener"] = any(
            f"socket:[{listener['inode']}]" in inodes for listener in listeners
        )
    except OSError as error:
        result["child_fds_error"] = type(error).__name__
    try:
        result["memory_events"] = Path("/sys/fs/cgroup/memory.events").read_text().strip()
    except OSError as error:
        result["memory_events_error"] = type(error).__name__
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        parser.error("a child command is required")
    child = subprocess.Popen(command, start_new_session=True)
    shutdown_at: float | None = None

    def forward_signal(number: int, _frame: Any) -> None:
        nonlocal shutdown_at
        emit("observer_signal", signal=number, child_pid=child.pid)
        shutdown_at = time.monotonic() + 10
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, number)

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)
    emit("child_started", child_pid=child.pid)
    previous: dict[str, Any] | None = None
    last_sample = time.monotonic()
    last_emit = 0.0
    try:
        while True:
            now = time.monotonic()
            state = snapshot(child.pid)
            code = child.poll()
            if state != previous or now - last_emit >= _REPORT_INTERVAL_S or now - last_sample > 1:
                emit(
                    "process_observation", returncode=code, sample_gap_s=now - last_sample, **state
                )
                previous = state
                last_emit = now
            last_sample = now
            if code is not None:
                emit("child_exited", returncode=code, **state)
                return code if code >= 0 else 128 - code
            if shutdown_at is not None and now >= shutdown_at:
                emit("shutdown_deadline", child_pid=child.pid)
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
            time.sleep(0.25)
    finally:
        if child.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
        child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
