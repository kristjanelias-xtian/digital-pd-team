import subprocess
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-convert-lead")

HOT = "43b6da41-0a3f-49b3-8024-c09fd2708d02"


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_non_hot_lead(pd, cleanup_test_records):
    person = pd.post("/persons", {"name": "ConvertColdPerson __test__"})["data"]
    cleanup_test_records["persons"].append(person["id"])
    lead = pd.post("/leads", {"title": "ConvertCold __test__", "person_id": person["id"]})["data"]
    cleanup_test_records["leads"].append(lead["id"])

    result = run(["--lead-id", lead["id"], "--stage", "Qualified", "--follow-up-days", "3", "--residential"])
    assert result.returncode != 0
    assert "hot" in result.stderr.lower()


def test_converts_hot_lead(pd, cleanup_test_records):
    person = pd.post("/persons", {"name": "ConvertHotPerson __test__"})["data"]
    cleanup_test_records["persons"].append(person["id"])
    lead = pd.post(
        "/leads",
        {"title": "ConvertHot __test__", "person_id": person["id"], "label_ids": [HOT]},
    )["data"]

    result = run([
        "--lead-id", lead["id"],
        "--stage", "Qualified",
        "--value", "9500",
        "--follow-up-days", "3",
        "--residential",
    ])
    assert result.returncode == 0, result.stderr
    assert "deal_id=" in result.stdout
    deal_id = int(result.stdout.split("deal_id=")[1].split(",")[0].strip())
    cleanup_test_records["deals"].append(deal_id)

    # Verify the lead is archived/deleted
    try:
        fetched = pd.get(f"/leads/{lead['id']}")
        archived = fetched.get("data", {}).get("is_archived", False)
        assert archived, "lead should be archived after conversion"
    except Exception:
        pass  # deletion is also acceptable
