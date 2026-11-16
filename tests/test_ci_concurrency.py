"""Only superseded PR verification may cancel an earlier workflow run."""

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_GROUP = "${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.run_attempt == '1' && github.event.pull_request.number || github.run_id }}-${{ github.run_attempt }}"
_CANCEL = "${{ github.event_name == 'pull_request' && github.run_attempt == '1' }}"


def _settings(workflow):
    text = (_ROOT / f".github/workflows/{workflow}.yml").read_text()
    match = re.search(r"^concurrency:\n  group: (.+)\n  cancel-in-progress: (.+)$", text, re.MULTILINE)
    assert match is not None
    assert match.groups() == (_GROUP, _CANCEL)
    return match.groups()


def _render(expression, workflow, event, run, pr=None, attempt=1):
    # Evaluate only the three exact, repository-owned expressions asserted
    # above. Their equality/boolean operators have the same semantics for
    # these nonempty strings, positive IDs and None as Actions expressions.
    github = SimpleNamespace(
        workflow=workflow,
        event_name=event,
        run_id=run,
        run_attempt=str(attempt),
        event=SimpleNamespace(pull_request=SimpleNamespace(number=pr)),
    )

    def value(match):
        source = match[1].strip().replace("&&", "and").replace("||", "or")
        return str(eval(source, {"__builtins__": {}}, {"github": github}))

    return re.sub(r"\$\{\{(.*?)\}\}", value, expression)


@pytest.mark.parametrize("workflow", ["lint", "browser"])
def test_only_same_pr_in_same_workflow_shares_a_cancellable_group(workflow):
    group, cancel = _settings(workflow)
    first = _render(group, workflow, "pull_request", 100, 42)
    assert first == _render(group, workflow, "pull_request", 101, 42)
    assert first != _render(group, workflow, "pull_request", 102, 43)
    assert first != _render(group, "another-workflow", "pull_request", 103, 42)
    assert _render(cancel, workflow, "pull_request", 100, 42) == "True"


@pytest.mark.parametrize("workflow", ["lint", "browser"])
@pytest.mark.parametrize("event", ["push", "merge_group", "workflow_dispatch", "release", "schedule"])
def test_non_pr_runs_are_unique_and_cannot_cancel(workflow, event):
    group, cancel = _settings(workflow)
    assert _render(group, workflow, event, 100) != _render(group, workflow, event, 101)
    assert _render(group, workflow, event, 100) != _render(group, workflow, "pull_request", 101, 100)
    assert _render(cancel, workflow, event, 100) == "False"


@pytest.mark.parametrize("workflow", ["lint", "browser"])
def test_rerunning_an_older_pr_commit_cannot_cancel_latest(workflow):
    group, cancel = _settings(workflow)
    latest = _render(group, workflow, "pull_request", 101, 42)
    rerun = _render(group, workflow, "pull_request", 100, 42, attempt=2)
    assert rerun != latest
    assert rerun != _render(group, workflow, "pull_request", 102, 42, attempt=2)
    assert rerun != _render(group, workflow, "pull_request", 100, 42, attempt=3)
    assert _render(cancel, workflow, "pull_request", 100, 42, attempt=2) == "False"
