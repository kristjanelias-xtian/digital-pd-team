import subprocess
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-advance-stage")

STAGES = {"Qualified": 12, "Site Visit Scheduled": 13, "Proposal Sent": 14, "Negotiation": 15}


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_missing_reason():
    result = run(["--deal-id", "1", "--to", "Proposal Sent"])
    assert result.returncode != 0
    assert "reason" in result.stderr.lower()


def test_refuses_illegal_backward_transition(pd, cleanup_test_records):
    deal = pd.post("/deals", {
        "title": "AdvanceBackward __test__",
        "pipeline_id": 3,
        "stage_id": STAGES["Proposal Sent"],
    })["data"]
    cleanup_test_records["deals"].append(deal["id"])

    result = run(["--deal-id", str(deal["id"]), "--to", "Qualified", "--reason", "backtrack"])
    assert result.returncode != 0
    assert "illegal" in result.stderr.lower() or "backward" in result.stderr.lower()


def test_advances_forward(pd, cleanup_test_records):
    deal = pd.post("/deals", {
        "title": "AdvanceForward __test__",
        "pipeline_id": 3,
        "stage_id": STAGES["Qualified"],
    })["data"]
    cleanup_test_records["deals"].append(deal["id"])

    result = run([
        "--deal-id", str(deal["id"]),
        "--to", "Site Visit Scheduled",
        "--reason", "prospect agreed to visit",
    ])
    assert result.returncode == 0, result.stderr
    refreshed = pd.get(f"/deals/{deal['id']}")["data"]
    assert refreshed["stage_id"] == STAGES["Site Visit Scheduled"]
