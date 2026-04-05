import subprocess
import time
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-find-or-create-org")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_placeholder_name():
    result = run(["--name", "test"])
    assert result.returncode != 0
    assert "placeholder" in result.stderr.lower()


def test_refuses_short_name():
    result = run(["--name", "ab"])
    assert result.returncode != 0


def test_creates_new_org(pd, cleanup_test_records):
    result = run(["--name", "OrgCreateAlpha __test__"])
    assert result.returncode == 0
    assert "org_id=" in result.stdout
    assert "created" in result.stdout
    org_id = int(result.stdout.split("org_id=")[1].split()[0])
    cleanup_test_records["organizations"].append(org_id)


def test_returns_existing_org(pd, cleanup_test_records):
    resp = pd.post("/organizations", {"name": "OrgCreateBeta __test__"})
    existing_id = resp["data"]["id"]
    cleanup_test_records["organizations"].append(existing_id)

    # Let PD search index catch up
    time.sleep(3)

    result = run(["--name", "OrgCreateBeta __test__"])
    assert result.returncode == 0
    assert f"org_id={existing_id}" in result.stdout
    assert "found" in result.stdout
