// The mach module every job's sandbox gets (written to /vercel/job/.mach, on
// PYTHONPATH for the job's commands): mach.decide for a skill's scripts, and
// mach.outcome to record what a person decided. It's Python; it lives here as
// text so the app can write it into sandboxes. A test checks it parses.
export const MACH_PY = String.raw`"""mach: helpers for a job's scripts in Mach1 (docs/agent-design.md, Decisions inside skills).

    import mach
    answers = mach.decide(
        skill="masttro-weekly-tagging",
        state="Counterparty ACME LTD, seen 14 times before. Amount matches the last three payments. Monthly, last paid 3 Sept.",
        questions={
            "tag": {"instructions": "Which tag fits this transaction?", "options": tags},  # fetched fresh each run
            "repeat": {"type": "boolean", "instructions": "Does this repeat an earlier transaction?"},
        },
        key="ACME LTD",  # past cases with the same key come first
        target=0.98,     # how often an automatic answer must be right
    )
    answers["tag"]  # {"id": ..., "choice": "Rent", "probability": 0.97, "auto": False, "threshold": None}

    # Later, when a person confirms or changes it:
    mach.outcome(answers["tag"]["id"], final="Rent", by="Rita")

Give it facts, not raw numbers to compare: turn amounts and dates into plain statements in code first.
"auto" is True only when the backtest on people's past answers says this one can be applied without asking.
There's always a "none of these" option. No key is needed: the sandbox adds the job's token on the way out.

From the shell: python3 -m mach decide < request.json    python3 -m mach outcome ID FINAL BY
"""

import json
import os
import sys
import urllib.error
import urllib.request

APP = os.environ.get("MACH_APP_URL", "").rstrip("/")


def _post(path, payload):
    if not APP:
        raise RuntimeError("mach: MACH_APP_URL isn't set; run this in a job's sandbox.")
    request = urllib.request.Request(
        APP + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            message = json.loads(body).get("error", body)
        except ValueError:
            message = body
        raise RuntimeError(f"mach: {message}") from None


def decide(skill, state, questions, key=None, target=None):
    """Answers questions about one state: {question: {id, choice?, probability, probabilities?, auto, threshold}}."""
    payload = {"skill": skill, "state": state, "questions": questions}
    if key is not None:
        payload["key"] = str(key)
    if target is not None:
        payload["target"] = target
    return _post("/api/decide", payload)["answers"]


def outcome(decision_id, final, by):
    """Records what a person decided: "confirmed" if it was the choice, else "changed"."""
    return _post("/api/decide/outcome", {"id": decision_id, "final": str(final), "by": by})["outcome"]


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "decide":
        request = json.load(sys.stdin)
        print(json.dumps(decide(request["skill"], request["state"], request["questions"], request.get("key"), request.get("target"))))
    elif command == "outcome" and len(sys.argv) == 5:
        print(outcome(sys.argv[2], sys.argv[3], sys.argv[4]))
    else:
        print(__doc__)
        sys.exit(2)
`;
