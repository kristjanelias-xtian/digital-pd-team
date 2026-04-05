import subprocess
from pathlib import Path

HELPER = str(Path(__file__).resolve().parent.parent / "pd-note")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([HELPER, *args], capture_output=True, text=True)


def test_refuses_long_summary():
    long_summary = "x" * 200
    result = run(["--on", "deal", "--id", "1", "--summary", long_summary, "--next-action", "do thing"])
    assert result.returncode != 0
    assert "140" in result.stderr or "summary" in result.stderr.lower()


def test_refuses_too_many_facts():
    facts = ";".join(f"fact{i}" for i in range(8))
    result = run(["--on", "deal", "--id", "1", "--summary", "s", "--facts", facts, "--next-action", "n"])
    assert result.returncode != 0
    assert "facts" in result.stderr.lower() or "6" in result.stderr


def test_refuses_markdown_table_in_summary():
    result = run(["--on", "deal", "--id", "1", "--summary", "| a | b |", "--next-action", "n"])
    assert result.returncode != 0
    assert "table" in result.stderr.lower()


def test_writes_well_formed_note(pd, cleanup_test_records):
    # Create a throwaway deal to attach the note to
    resp = pd.post("/deals", {"title": "NoteTestDeal __test__", "pipeline_id": 3, "stage_id": 12})
    deal_id = resp["data"]["id"]
    cleanup_test_records["deals"].append(deal_id)

    result = run([
        "--on", "deal", "--id", str(deal_id),
        "--summary", "Discovery call done — strong fit",
        "--facts", "South-facing roof;Budget confirmed;Ready to propose",
        "--next-action", "Site visit Apr 11",
    ])
    assert result.returncode == 0, result.stderr
    assert "note_id=" in result.stdout
    note_id = int(result.stdout.split("note_id=")[1].split()[0])
    cleanup_test_records["notes"].append(note_id)

    # Fetch the note and verify structure
    note = pd.get(f"/notes/{note_id}")["data"]
    content = note["content"]
    assert "Discovery call done — strong fit" in content
    assert "South-facing roof" in content
    assert "Next:" in content
    assert content.count("\n") <= 12
