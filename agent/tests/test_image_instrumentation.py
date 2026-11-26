import json
import os
import re
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
_VARIABLE = "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"
_INSTRUCTION = re.compile(rf'ENV\s+{_VARIABLE}=("?)([^\s"]+)\1')
_COPY_INTO_HEADERS = {"requests", "urllib3"}

_ACTIVE = """\
import json
from importlib.metadata import entry_points

print(json.dumps({
    point.name: point.load()().is_instrumented_by_opentelemetry
    for point in entry_points(group="opentelemetry_instrumentor")
    if point.name in ("requests", "urllib3", "botocore", "httpx2")
}))
"""
_VALUE = f"import os\nprint(os.environ.get({_VARIABLE!r}, ''))\n"


def _value_in_image() -> str:
    lines = _DOCKERFILE.read_text(encoding="utf-8").splitlines()
    final_stage = max(i for i, line in enumerate(lines) if line.startswith("FROM "))
    mentions = [
        line.strip()
        for line in lines[final_stage:]
        if _VARIABLE in line and not line.lstrip().startswith("#")
    ]
    instruction = _INSTRUCTION.fullmatch(mentions[0]) if len(mentions) == 1 else None
    assert instruction, (
        f"agent/Dockerfile must set {_VARIABLE} exactly once in its final stage, in an ENV "
        f'instruction of its own (`ENV {_VARIABLE}="a,b,c"`), so that the list can be read here. '
        f"Lines of that stage that name the variable outside comments: {mentions}. Without it "
        "the image loads every installed instrumentation, and those of `requests` and "
        "`urllib3` copy the trace context and the task's correlation baggage into the headers "
        "of every request."
    )
    return instruction.group(2)


def _names(value: str) -> list[str]:
    return [name.strip() for name in value.split(",") if name.strip()]


def _under_the_wrapper(program: str, cwd: Path, **variables: str) -> str:
    """The AWS configurator asks the EC2 metadata address about its host: the SDK's own is set."""
    env = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith("OTEL_") and name != "AGENT_OBSERVABILITY_ENABLED"
    }
    env.update(
        OTEL_PYTHON_DISTRO="aws_distro",
        OTEL_PYTHON_CONFIGURATOR="configurator",
        OTEL_TRACES_EXPORTER="none",
        OTEL_METRICS_EXPORTER="none",
        OTEL_LOGS_EXPORTER="none",
        **variables,
    )
    wrapper = Path(sys.executable).with_name("opentelemetry-instrument")
    done = subprocess.run(
        [str(wrapper), sys.executable, "-c", program],
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert done.returncode == 0, f"{wrapper} failed:\n{done.stderr}"
    return done.stdout.strip()


def test_dockerfile_names_the_instrumentations_that_copy_context_into_headers() -> None:
    missing = sorted(_COPY_INTO_HEADERS - set(_names(_value_in_image())))
    assert not missing, (
        f"{_VARIABLE} in agent/Dockerfile does not name {missing}. Under "
        "`opentelemetry-instrument` the instrumentations of `requests` and `urllib3` copy the "
        "trace context and the task's correlation baggage (session id, user id, repository) "
        "into the headers of every request they send, and the agent calls Linear and "
        "Atlassian with `requests`. Keep both names in the list."
    )


def test_wrapper_loads_neither_with_the_value_of_the_dockerfile(tmp_path: Path) -> None:
    value = _value_in_image()
    active = json.loads(_under_the_wrapper(_ACTIVE, tmp_path, **{_VARIABLE: value}))
    assert active == {"requests": False, "urllib3": False, "botocore": True, "httpx2": True}, (
        f"With {_VARIABLE}={value} (the value of agent/Dockerfile) the wrapper activated "
        f"{active}. `requests` and `urllib3` must be off: they copy the trace context and the "
        "task's correlation baggage into the headers of the agent's requests to Linear and "
        "Atlassian. `botocore` and `httpx2` must be on: they belong to the clients of AWS and "
        "of the platform's tool gateway, and they show that the wrapper loaded its "
        "instrumentations at all."
    )


def test_dockerfile_list_is_the_one_the_distro_applies_in_agent_mode(tmp_path: Path) -> None:
    of_distro = _names(_under_the_wrapper(_VALUE, tmp_path, AGENT_OBSERVABILITY_ENABLED="true"))
    in_image = _names(_value_in_image())
    wanted = of_distro + sorted(_COPY_INTO_HEADERS - set(of_distro))
    assert of_distro and set(in_image) == set(wanted), (
        f"aws-opentelemetry-distro {version('aws-opentelemetry-distro')} switches off "
        f"{of_distro} in its agent observability mode (AGENT_OBSERVABILITY_ENABLED=true); "
        f"agent/Dockerfile names {in_image}. An explicit value replaces the distro's list, "
        "so in that mode the image would run with another set of instrumentations than the "
        f'distro means it to. Write the instruction as `ENV {_VARIABLE}="{",".join(wanted)}"`. '
        "If the first list is empty, this distro no longer puts its list into that "
        "variable: find where it decides now and change this test."
    )
