import asyncio
import json
import shutil
import subprocess
import sys
import threading

_PYTHON_CHILD = """\
import json, sys, time
print(json.dumps({"type": "init", "index": 0}), flush=True)
time.sleep(0.3)
for i in range(1, 6):
    print(json.dumps({"type": "assistant", "index": i}), flush=True)
    time.sleep(0.3)
print(json.dumps({"type": "result", "index": 6}), flush=True)
"""

_NODE_CHILD = """\
const delays = [0, 300, 300, 300, 300, 300, 0];
let index = 0;
function writeNext() {
  if (index > 6) return;
  const types = ['init','assistant','assistant','assistant','assistant','assistant','result'];
  const msg = JSON.stringify({type: types[index], index: index});
  process.stdout.write(msg + '\\n');
  index++;
  if (index <= 6) setTimeout(writeNext, delays[index]);
}
writeNext();
"""

EXPECTED_COUNT = 7


async def _read_subprocess(cmd: list[str]) -> list[dict]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    messages: list[dict] = []
    if proc.stdout is None:
        await proc.wait()
        return messages
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode().strip()
        if text:
            msg = json.loads(text)
            messages.append(msg)

    await proc.wait()
    return messages


def _run_in_bg_thread_asyncio_run(cmd: list[str]) -> dict:
    result: dict = {"messages": [], "error": None}

    def worker():
        try:
            result["messages"] = asyncio.run(_read_subprocess(cmd))
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"

    t = threading.Thread(target=worker)
    t.start()
    t.join(timeout=30)
    if t.is_alive():
        result["error"] = "Thread timed out (30s)"
    return result


def _run_in_bg_thread_threadsafe(cmd: list[str], loop: asyncio.AbstractEventLoop) -> dict:
    result: dict = {"messages": [], "error": None}

    def worker():
        try:
            future = asyncio.run_coroutine_threadsafe(_read_subprocess(cmd), loop)
            result["messages"] = future.result(timeout=30)
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"

    t = threading.Thread(target=worker)
    t.start()
    t.join(timeout=30)
    if t.is_alive():
        result["error"] = "Thread timed out (30s)"
    return result


def _run_in_main_thread(cmd: list[str]) -> dict:
    result: dict = {"messages": [], "error": None}
    try:
        result["messages"] = asyncio.run(_read_subprocess(cmd))
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    return result


def _print_result(label: str, result: dict) -> int:
    count = len(result["messages"])
    status = "PASS" if count == EXPECTED_COUNT else "FAIL"
    print(f"  {label:45s}  {count}/{EXPECTED_COUNT}  [{status}]")
    if result["error"]:
        print(f"    Error: {result['error']}")
    return count


async def _run_tests(py_cmd: list[str], node_cmd: list[str] | None, node_version: str) -> bool:
    loop = asyncio.get_running_loop()

    print(f"Python:     {sys.version}")
    print(f"Platform:   {sys.platform}")
    print(f"Loop:       {type(loop).__name__}")
    if node_cmd:
        print(f"Node.js:    {node_version}")
    else:
        print("Node.js:    not found (skipping Node.js tests)")
    print(f"Expected:   {EXPECTED_COUNT} messages per test")
    print()

    results: dict[str, int] = {}

    print("Python child process:")
    r = await loop.run_in_executor(None, _run_in_bg_thread_asyncio_run, py_cmd)
    results["py_bg_run"] = _print_result("bg thread + asyncio.run()", r)

    r = await loop.run_in_executor(None, _run_in_bg_thread_threadsafe, py_cmd, loop)
    results["py_bg_safe"] = _print_result("bg thread + run_coroutine_threadsafe()", r)
    print()

    if node_cmd:
        print("Node.js child process:")
        r = await loop.run_in_executor(None, _run_in_bg_thread_asyncio_run, node_cmd)
        results["node_bg_run"] = _print_result("bg thread + asyncio.run()", r)

        r = await loop.run_in_executor(None, _run_in_bg_thread_threadsafe, node_cmd, loop)
        results["node_bg_safe"] = _print_result("bg thread + run_coroutine_threadsafe()", r)
        print()

    all_pass = all(v == EXPECTED_COUNT for v in results.values())
    any_fail = any(v < EXPECTED_COUNT for v in results.values())

    print("=" * 60)
    if all_pass:
        print("All tests PASS on this platform.")
        print("Subprocess pipe I/O works from background threads.")
        print()
        print("The issue is NOT asyncio.run() in a background thread.")
        print("Likely causes to investigate:")
        print("  1. SDK/CLI version mismatch (protocol incompatibility)")
        print("  2. Bedrock API connectivity (VPC, IAM, endpoint)")
        print("  3. CLI crash after init (check exit code)")
        print()
        print("Next step: run test_sdk_smoke.py inside the deployed")
        print("container to test the actual SDK→CLI→Bedrock path.")
    elif any_fail:
        bg_run_fail = results.get("py_bg_run", 0) < EXPECTED_COUNT
        bg_safe_pass = results.get("py_bg_safe", 0) == EXPECTED_COUNT
        if bg_run_fail and bg_safe_pass:
            print("CONFIRMED: asyncio.run() in bg thread drops messages.")
            print("           run_coroutine_threadsafe() fixes it.")
        else:
            print("Mixed results — see details above.")
    print("=" * 60)
    return all_pass


if __name__ == "__main__":
    py_cmd = [sys.executable, "-c", _PYTHON_CHILD]
    node_bin = shutil.which("node")
    node_cmd = ["node", "-e", _NODE_CHILD] if node_bin else None

    print("Baseline: asyncio.run() in main thread, Python child")
    baseline = _run_in_main_thread(py_cmd)
    count = _print_result("main thread + asyncio.run()", baseline)
    if count != EXPECTED_COUNT:
        print("  Baseline FAILED — subprocess I/O broken even on main thread!")
        sys.exit(2)

    if node_cmd:
        print()
        print("Baseline: asyncio.run() in main thread, Node.js child")
        baseline_node = _run_in_main_thread(node_cmd)
        count = _print_result("main thread + asyncio.run()", baseline_node)
        if count != EXPECTED_COUNT:
            print("  Node.js baseline FAILED!")
            sys.exit(2)
    print()

    node_version = ""
    if node_cmd:
        node_version = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    sys.exit(0 if asyncio.run(_run_tests(py_cmd, node_cmd, node_version)) else 1)
