# Repository visibility (public ↔ private)

All five repositories are public today. `backend` and `frontend` stay public by
decision (2026-10-21). `cloud-provisioning` and `specification` may turn private
later. This runbook lists what has to be true before one turns private, so the
switch is a one-line change and nothing in production breaks.

Visibility is set per repository in `REPOSITORY_VISIBILITY`
(`src/github/components/organization.ts`). A prod `pulumi up` applies it.

## Once, before the first repository turns private

1. **Plan: GitHub Team.** On GitHub Free, a private repository loses branch
   protection and rulesets (the `CI Success` gate and the `cloud-provisioning`
   prod ruleset), and Environments with their variables and secrets (`dev`,
   `prod`: the deploy workflows and `incident-triage.yml` read them). Team keeps
   all of these. Required reviewers on Environments stay Enterprise-only, and no
   workflow uses them any more.
2. **Actions minutes.** Private repositories are billed: 2,000 included minutes
   on Free, 3,000 on Team, then $0.006 per Linux minute. Per-repository usage is
   on liverty-music/cloud-provisioning#666. Private runners are also 2 vCPU
   instead of 4, so jobs take longer.
3. **Security features.** Secret scanning and push protection need GitHub
   Secret Protection on a private repository. `visibilityArgs` stops setting
   them once a repository is private, so nothing has to be edited. CodeQL
   default setup (enabled on `backend` and `frontend` through the API, not
   Pulumi) needs GitHub Code Security on a private repository. Turn it off with
   `gh api -X PATCH repos/liverty-music/<repo>/code-scanning/default-setup -f state=not-configured`.

## Per repository

| Repository | Reads it without credentials today | Must be in place before the switch |
|---|---|---|
| `cloud-provisioning` | ArgoCD (every Application and both root apps) | ArgoCD repository credential (below) |
| `backend` | ArgoCD (`backend-migrations`), `specification` CI | ArgoCD repository credential; CI clone token (below) |
| `frontend` | `specification` CI | CI clone token (below) |
| `specification` | Cloud threads (each `AGENTS.md` clones it over plain HTTPS when no sibling checkout exists) | See "Cloud threads" below |
| `.github` | Every repository calls its reusable `claude-review.yml` | Settings → Actions → General → Access: "Accessible from repositories in the liverty-music organization" |

### ArgoCD repository credential

ArgoCD fetches `https://github.com/liverty-music/cloud-provisioning.git` and
`…/backend.git` with no credential. A private repository returns 404 to it, and
prod sync and Atlas migrations stop. Before the switch, a `repo-creds` Secret
for `https://github.com/liverty-music` must hold a GitHub App credential with
`Contents: read` on both repositories, and every Application must show
`Synced`/`Healthy` with it in place. The credential has to work before it is
added: once it exists, ArgoCD uses it for public repositories too.

### CI clone token (`specification` → `backend`, `frontend`, `cloud-provisioning`)

The `openspec-checks` job clones the implementing repositories to check
scenario coverage when a change is archived. It uses the `IMPLEMENTING_REPOS_TOKEN`
secret when the repository has one and clones anonymously otherwise, so it keeps
working while everything is public. Before any of the three turns private, set
that secret on `specification` to a fine-grained token with only
`Contents: read` on the three repositories (liverty-music/specification#1220). It
expires, and an expired token fails the clone even of a public repository, so
renew it before the date or delete the secret.

### Cloud threads

A multi-repository thread has a sibling `specification` checkout and needs
nothing. A single-repository thread clones `specification` over plain HTTPS,
which fails once it is private. Add `specification` to every cloud thread's
repositories, then change the clone line in each `AGENTS.md` and the
`specification` README.

## Switch

1. Confirm every row of the table above for the repository.
2. Change its entry in `REPOSITORY_VISIBILITY` to `'private'` in a PR. The prod
   preview must show only the repository update.
3. Merge. The user runs prod `pulumi up`.
4. Verify: `gh api repos/liverty-music/<repo> --jq .visibility` is `private`;
   ArgoCD Applications are `Synced`/`Healthy`; the next PR's `CI Success` is
   required and green.

Public forks stay public in a separate network: `wzd8888/backend` (forked
2026-10-13) keeps the code it copied whatever this repository becomes
(GitHub Docs, "What happens to forks when a repository is deleted or changes
visibility").
