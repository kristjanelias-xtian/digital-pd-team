import subprocess
import time
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-new-lead")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_missing_title():
    result = run(["--person-id", "1"])
    assert result.returncode != 0
    assert "title" in result.stderr.lower()


def test_refuses_missing_person_id():
    result = run(["--title", "Whatever __test__"])
    assert result.returncode != 0
    assert "person" in result.stderr.lower()


def test_creates_lead(pd, cleanup_test_records):
    # Need a person to link
    person = pd.post("/persons", {"name": "LeadTestPerson __test__"})["data"]
    cleanup_test_records["persons"].append(person["id"])

    # PD search index lag — let the person become findable before pd-new-lead's duplicate check runs
    time.sleep(3)

    result = run(["--title", "LeadTestAlpha __test__", "--person-id", str(person["id"])])
    assert result.returncode == 0, result.stderr
    assert "lead_id=" in result.stdout
    lead_id = result.stdout.split("lead_id=")[1].split()[0]
    cleanup_test_records["leads"].append(lead_id)
