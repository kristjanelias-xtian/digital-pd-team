import subprocess
from datetime import datetime, timedelta
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-new-deal")

STAGES = {"Qualified": 12, "Site Visit Scheduled": 13, "Proposal Sent": 14}


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_missing_follow_up():
    result = run([
        "--title", "DealNoFollowup __test__",
        "--person-id", "1",
        "--stage", "Qualified",
        "--residential",
    ])
    assert result.returncode != 0
    assert "follow-up" in result.stderr.lower() or "follow_up" in result.stderr.lower()


def test_refuses_missing_org_on_commercial():
    result = run([
        "--title", "DealCommercialNoOrg __test__",
        "--person-id", "1",
        "--stage", "Qualified",
        "--follow-up-days", "3",
        # no --residential and no --org-id
    ])
    assert result.returncode != 0
    assert "org" in result.stderr.lower() or "commercial" in result.stderr.lower()


def test_creates_deal_with_activity(pd, cleanup_test_records):
    person = pd.post("/persons", {"name": "DealTestPerson __test__"})["data"]
    cleanup_test_records["persons"].append(person["id"])

    result = run([
        "--title", "DealCreate __test__",
        "--person-id", str(person["id"]),
        "--stage", "Qualified",
        "--value", "9500",
        "--follow-up-days", "3",
        "--residential",
    ])
    assert result.returncode == 0, result.stderr
    assert "deal_id=" in result.stdout
    assert "activity_id=" in result.stdout

    deal_id = int(result.stdout.split("deal_id=")[1].split(",")[0].strip())
    cleanup_test_records["deals"].append(deal_id)

    # Verify the deal actually has the linkage and activity
    deal = pd.get(f"/deals/{deal_id}")["data"]
    assert deal["stage_id"] == STAGES["Qualified"]
    # person_id may be int or dict depending on PD's response shape
    pid = deal["person_id"]
    if isinstance(pid, dict):
        assert pid.get("value") == person["id"]
    else:
        assert pid == person["id"]
    # Verify activity exists
    acts = pd.get(f"/deals/{deal_id}/activities")
    assert acts.get("data") and len(acts["data"]) >= 1
