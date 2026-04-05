import subprocess
import time
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-search")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_missing_term():
    result = run([])
    assert result.returncode != 0
    assert "term" in result.stderr.lower()


def test_returns_empty_for_nonsense(pd, cleanup_test_records):
    result = run(["ZZZZNOMATCHZZZZ__test__"])
    assert result.returncode == 0
    assert "no matches" in result.stdout.lower()


def test_finds_existing_person(pd, cleanup_test_records):
    # Create a person we can find
    body = {"name": "SearchTestAlpha __test__", "email": [{"value": "alpha@example.invalid"}]}
    resp = pd.post("/persons", body)
    person_id = resp["data"]["id"]
    cleanup_test_records["persons"].append(person_id)

    # PD search index takes ~2s to reflect newly created records
    time.sleep(3)

    result = run(["SearchTestAlpha"])
    assert result.returncode == 0
    assert "person" in result.stdout
    assert str(person_id) in result.stdout
