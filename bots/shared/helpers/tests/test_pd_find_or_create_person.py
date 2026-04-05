import subprocess
import time
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-find-or-create-person")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_missing_name():
    result = run(["--email", "x@y.z"])
    assert result.returncode != 0
    assert "name" in result.stderr.lower()


def test_creates_new_person(pd, cleanup_test_records):
    result = run(["--name", "FindCreateAlpha __test__", "--email", "alpha_fc@example.invalid"])
    assert result.returncode == 0
    assert "person_id=" in result.stdout
    assert "created" in result.stdout
    person_id = int(result.stdout.split("person_id=")[1].split()[0])
    cleanup_test_records["persons"].append(person_id)


def test_returns_existing_person(pd, cleanup_test_records):
    # Pre-create
    resp = pd.post("/persons", {"name": "FindCreateBeta __test__", "email": [{"value": "beta_fc@example.invalid"}]})
    existing_id = resp["data"]["id"]
    cleanup_test_records["persons"].append(existing_id)

    # Give PD's search index time to pick up the new person (~2s lag observed)
    time.sleep(3)

    # Second call with same email should find, not create
    result = run(["--name", "FindCreateBeta __test__", "--email", "beta_fc@example.invalid"])
    assert result.returncode == 0
    assert f"person_id={existing_id}" in result.stdout
    assert "found" in result.stdout
