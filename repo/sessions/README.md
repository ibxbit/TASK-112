# Model Trajectory / Session Artifacts

This folder is the delivery slot for AI-assisted development trajectories, per the company delivery standard (see parent `doc.md`, §Step 3 and the "Model trajectory file" requirement).

## Expected contents

- `trajectory.json` — OpenAI-format export produced by `convert_ai_session.py` (Claude JSONL, Codex JSONL, Gemini JSON, OpenCode JSON, or Kilocode are all accepted sources).
- If multiple sessions are required, rename to `trajectory-1.json`, `trajectory-2.json`, … inside this folder.
- Pre-conversion raw session files (`*.jsonl`) MAY be kept next to the converted files for traceability.

## Session files from this delivery

The converted, development-stage trajectories for this project are stored one level up under:

```
../sessions/            (at the TASK-112 parent level)
├── bugfix-1.json
├── bugfix-2.json
├── bugfix-3.json
└── develop-1.json
```

Those files are the authoritative trajectory record for QA. This in-repo `sessions/` folder exists so the deliverable is self-describing even when the repo is vendored on its own.

## Self-test evidence

Screenshots or a walkthrough video of a green run (`docker compose up -d` → browse <http://localhost:8080> → administrator bootstrap → Queue Board → Equipment Panel → Calendar → Meetings → Notifications → Auditor Trail) should be attached alongside this folder by the submitter.

## OpenAI-format schema (reference)

```json
{
  "messages": [
    { "role": "user|assistant|tool", "content": [ { "type": "text|tool_use", "text": "…" } ], "tool_calls": [] }
  ],
  "meta": {
    "session_meta": { "id": "…", "timestamp": "…", "cwd": "…", "originator": "…", "cli_version": "…", "source": "…", "model_provider": "…" },
    "turn_contexts": [],
    "token_counts": null
  }
}
```
