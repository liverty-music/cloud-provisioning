# Runbook: nightly CI failures on main, triaged by Claude

When the nightly CI run on `main` of frontend or backend fails, the Issue
"CI failing on main" opens, a Claude Code routine on claude.ai reads the
failure, opens a fix pull request when it can, comments its analysis on the
Issue and posts one message to Slack `#general`. The owner reviews and merges
the pull request like any other; nothing merges on its own.

OpenSpec change: `fix-main-ci-failures-automatically` (design D1–D5 are cited
below).

## How it fits together

```
frontend ci.yaml / backend ci.yml   (schedule 17 19 * * * = 04:17 JST)
  ci-success ──► report-main-ci  (liverty-music/.github report-main-ci.yml)
                   failure, no open Issue → opens "CI failing on main"   ─┐
                   failure, Issue open    → comments run URL + sha        │
                   success, Issue open    → closes it (+ `flaky` label    │
                                            when that sha failed earlier) │
                                                                          ▼
claude.ai routines fix-main-ci-frontend / fix-main-ci-backend (GitHub trigger: Issue opened, author github-actions[bot])
  prompt: read routines/fix-main-ci.md in liverty-music/.github and follow it
  → acts only on the open Issue that github-actions[bot] opened
  → classifies: flaky test | real bug | infrastructure
  → fix: push claude/fix-main-ci-<issue>, open a normal pull request (Refs #<issue>)
  → comments on the Issue, posts to Slack #general
```

One routine run per outbreak: a failure while the Issue is open only adds a
comment, which is not a trigger. An outbreak ends when the Issue closes (a green
night, or the owner closing it).

| Piece | Where | Managed by |
|---|---|---|
| Issue lifecycle | `liverty-music/.github` `.github/workflows/report-main-ci.yml` | pull request |
| What the routine does | `liverty-music/.github` `routines/fix-main-ci.md` | pull request |
| Callers, cron | frontend `.github/workflows/ci.yaml`, backend `.github/workflows/ci.yml` (`report-main-ci` job) | pull request |
| Claude GitHub App on the repositories | Organization settings › GitHub Apps › claude (installation `111730201`): frontend, backend, `.github`, cloud-provisioning, specification | by hand (see below) |
| The routine and its trigger | claude.ai | by hand, settings below |
| Slack connector | claude.ai | by hand, once |
| `main` protection (PR + `CI Success` required, `enforce_admins`) | `src/github/components/repository.ts` | Pulumi (prod) |

The routine and the Slack connector have no API Pulumi can call: routines are
edited only on claude.ai or with `/schedule` in the CLI, and the connector is an
OAuth consent in the owner's browser (design D5).

The App's repository selection has an API, but it refuses the Pulumi GitHub
token: the prod `pulumi up` of 2026-11-22 failed with `PUT
/user/installations/111730201/repositories/<id>: 403 Resource not accessible by
personal access token` (the token is a fine-grained PAT). The selection is kept
by hand. The routine needs frontend, backend and `.github` in it.

## Routine settings

Create them at https://claude.ai/code/routines → **New task** → **Set up manually**,
signed in as the owner.

Two routines with the same settings except the repository: a routine's GitHub
trigger takes one repository, and the trigger list's **+** offers only Schedule
and API (checked 2026-11-22).

| Field | Value |
|---|---|
| Name | `fix-main-ci-frontend`, `fix-main-ci-backend` |
| Prompt | `Read routines/fix-main-ci.md in liverty-music/.github and follow it for the Issue that triggered this run.` |
| Advanced settings › General › Repository | the routine's own repository, plus `liverty-music/.github` |
| Cloud environment | default (Limited network, Allow package managers) |
| Trigger | **GitHub event**: Event `Issue: Opened`, repository `liverty-music/frontend` (or `backend`) |
| Trigger filter | Author, `is one of`, `github-actions[bot]` (the instructions' step 0 checks the author again) |
| Advanced settings › Connectors | Slack only; remove the others |

Checked 2026-11-22 with a failing test workflow on a `trial/` branch of each
repository, which called `report-main-ci.yml`: the Issue the workflow opened
started a run in both routines (the Author value `github-actions[bot]` matches),
and each run commented on the Issue that the failure was not a scheduled run on
`main`. An Issue with the same title opened by the owner got no comment.

The Slack connector is connected at https://claude.ai/customize/connectors
(Slack → connect → approve in Slack). The channel is named in the
instructions file: without one, a run posts to the owner's DM instead
(observed in the 2026-11-22 trial).

## What keeps a run from changing main

Claude pushes to `claude/` branches unless a prompt tells it otherwise, and the
routine's push goes out as the owner's identity. claude.ai documents no setting
that limits which branches a routine may push to; its docs say to use branch
protection. `main` of frontend and backend requires a pull request and
`CI Success`, and `enforce_admins` is on, so the owner's identity cannot push to
`main` either. Checked 2026-11-22:

```
$ gh api repos/liverty-music/frontend/branches/main/protection --jq '{enforce_admins: .enforce_admins.enabled, checks: .required_status_checks.contexts}'
{"checks":["CI Success"],"enforce_admins":true}
$ gh api repos/liverty-music/backend/branches/main/protection --jq '{enforce_admins: .enforce_admins.enabled, checks: .required_status_checks.contexts}'
{"checks":["CI Success"],"enforce_admins":true}
```

Re-run these after any change to branch protection. If `enforce_admins` is
ever turned off, pause the routine first.

## Operations

- **Pause**: on claude.ai, open the routine and turn it off. The Issue
  lifecycle keeps working; failures still open and close Issues, only the
  analysis, pull request and Slack message stop.
- **Change what it does**: edit `routines/fix-main-ci.md` by pull request. The
  routine reads the file from `main` of `liverty-music/.github` at each run.
- **Recreate**: create them again with the table above, and check the Slack
  connector is still connected.
- **A run did nothing**: open the routine's run on claude.ai. A run that ends
  at once is expected for an Issue not opened by `github-actions[bot]`, a
  closed Issue, or a second delivery of the same Issue (it already has a
  `<!-- fix-main-ci -->` comment or a `claude/fix-main-ci-<issue>` branch).
- **Limits**: GitHub events beyond the routine's hourly caps are dropped, and a
  missing or expired GitHub connection skips runs and turns the routine off
  after 72 hours. Runs count against the owner's Claude subscription.

## Fallback: GitHub Actions (design D4)

If the routine stops being usable (the trigger stops firing, limits block runs,
the research preview changes, or the fixes are poor), run the same
`routines/fix-main-ci.md` from a job in `report-main-ci.yml` with
`anthropics/claude-code-action` and the organization secret
`CLAUDE_CODE_OAUTH_TOKEN`, as `.github/workflows/incident-triage.yml` does here.
The Slack message then needs a Slack incoming webhook. That switch is its own
OpenSpec change.
