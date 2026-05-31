# Prod Image Tag Pinning — Policy & Runbook

## Policy summary

| Environment | Artifact Registry tag policy | Kustomize `newTag:` pin | Tag mutation allowed? |
|---|---|---|---|
| **prod** (`liverty-music-prod`) | `dockerConfig.immutableTags: true` on `backend` + `frontend` repos | Semantic version (e.g., `v1.0.0`) with commit SHA in inline comment | **No** — AR API rejects re-points with HTTP 409 |
| **staging** (not yet provisioned) | Will inherit `immutableTags: true` automatically when staging stack is created — the Pulumi conditional is `environment !== 'dev'`, fail-secure by default | TBD when staging overlays are created (expected: semver, same as prod) | **No** (post-creation) |
| **dev** (`liverty-music-dev`) | default (`immutableTags: false`) | Not pinned in overlay — ArgoCD Image Updater resolves `:latest` / `:main` dynamically | Yes — Image Updater rewrites every push |

The prod policy is enforced at two layers:
1. **Manifest layer** (kustomize overlays under `k8s/namespaces/{backend,frontend}/overlays/prod/`): `newTag:` SHALL be a semver string matching `^v\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$`. Commit-SHA-only tags and `:latest` SHALL NEVER appear.
2. **Registry layer** (GCP Artifact Registry, managed by Pulumi at `src/gcp/index.ts`): `dockerConfig.immutableTags: true` is set on the prod `backend` and `frontend` Docker repos. Once a tag is written, AR rejects any subsequent `docker push` or `gcloud artifacts docker tags add` that would re-point that tag to a different digest.

The combined effect is "readable semver in the manifest + cryptographic immutability at the registry boundary" — equivalent to digest pinning in immutability, superior in developer experience.

## Why immutable tags + semver instead of digest pinning

See `openspec/changes/archive/<date>-enable-prod-ar-immutable-tags/design.md` decision **D1** for the full rationale. Summary:

- **Digest pinning** (`digest: sha256:...` in kustomize, or `image@sha256:...`) is the K8s-recommended strongest form. Cryptographically unforgeable.
- **DX cost**: digest is only knowable after build. Operator workflow becomes: cut Release → wait for GHA → look up digest via `gcloud` → paste into overlay PR. Versus immutable-semver: cut Release → bump `newTag: v1.0.1` in overlay PR.
- **Equivalent security guarantee at the AR boundary**: immutable-tags blocks the same attacker class (compromised AR write IAM) as digest pinning, via API-level rejection of tag overwrites.

## Operator workflow: cutting a release

As of OpenSpec change `automate-prod-pin-bump` (tracking issue
liverty-music/specification#553), the prod pin-bump is **fully automated**.
Cutting the GitHub Release is the only human action; there is no longer a
manual pin-bump PR. The chain is:

```
GH Release (backend/frontend)
  → release workflow retags dev-AR digest → prod AR (:vX.Y.Z + :<sha>)
  → release workflow emits repository_dispatch (bump-prod-pin) → cloud-provisioning
  → bump-prod-pin.yml: validate payload → provenance gate (crane manifest)
                       → yq edit newTag + version label → kustomize build
                       → commit + push to main as github-actions[bot]
  → ArgoCD auto-syncs the prod overlay → Pods roll
```

### 1. Build + publish prod image (in `liverty-music/backend` or `liverty-music/frontend`)

1. Merge release-bound PRs to `main`.
2. From the GitHub UI: **Releases → Draft a new release → Tag = `v1.0.1`** (next patch) → Publish.
3. The release workflow (`deploy.yml` for backend, `push-image.yaml` for frontend) fires on `release: published`:
   - Authenticates to prod via Workload Identity Federation (`github-actions@liverty-music-prod.iam`).
   - Retags the dev-AR digest for `github.sha` into prod AR under `:v1.0.1` and `:<commit-sha>` (`crane copy`, no rebuild).
   - On retag success, the `dispatch-prod-pin` job emits a `repository_dispatch` (`event_type: bump-prod-pin`, `client_payload: { component, tag, sha }`) to `cloud-provisioning` via a short-lived GitHub App token.
   - For the backend 4-image matrix, the dispatch is gated on **all 4** entries succeeding (`needs.build-and-push.result == 'success'` with `fail-fast: false`), so a partial retag never bumps the pin.

### 2. Automated pin-bump (no manual action)

`bump-prod-pin.yml` in `cloud-provisioning` receives the dispatch and, for the named component:

1. Validates the payload (`component ∈ {backend, frontend}`, `tag` matches `^v[0-9]+\.[0-9]+\.[0-9]+$`).
2. **Provenance gate** — `crane manifest` every prod-AR image at `:tag` (4 for backend, 1 for frontend). A missing image **aborts before any edit** (fail-closed), rejecting bogus/stale tags and the silent-downgrade path.
3. Idempotency — if every `newTag` already equals `tag`, exits 0 without committing.
4. `yq` edit — rewrites every `images[].newTag` + its inline `# commit <sha>` trailer and the `app.kubernetes.io/version` label (bare semver, no `v`) in lock-step. The two-conventions `v`-prefix gotcha is handled in code: `newTag` keeps the `v`, the label strips it.
5. `kustomize build` of the edited prod overlay — a non-zero build **aborts before push** (replaces the CI gate the manual PR provided).
6. Commits as `github-actions[bot]` and pushes straight to `main` (fetch-rebase-retry, ≤5 attempts; `concurrency` serialized). No PR.

To watch it: `gh run list --repo liverty-music/cloud-provisioning --workflow bump-prod-pin.yml --limit 5`.

### 3. ArgoCD reconciles

ArgoCD detects the `cloud-provisioning:main` bump commit and rolls the prod Deployments / CronJobs with the new `image:` reference and `app.kubernetes.io/version` label. Pods restart; image bytes resolve via the AR tag → digest lookup.

### 4. Verify

```bash
kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
    -n backend get deploy,cronjob -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}'
```

All images SHALL end with `:v1.0.1`. For frontend, also run the prod smoke:
`gh workflow run push-image.yaml --repo liverty-music/frontend -f smoke_url=https://liverty-music.app`.

## Manual recovery: `workflow_dispatch` fallback (admin-only)

If a dispatch is dropped (e.g. a transient GitHub outage between the release
workflow and `cloud-provisioning`), the bump never lands. Recover by running
`bump-prod-pin.yml` manually with the same payload:

```bash
gh workflow run bump-prod-pin.yml --repo liverty-music/cloud-provisioning \
  -f component=backend -f tag=v1.0.1 -f sha=<release-commit-sha>
```

This path is **admin-gated**: `workflow_dispatch` runs bind the `prod-pin`
GitHub Environment (via the conditional `environment:` expression), which has a
required-reviewer rule, so the run pauses for admin approval before the bump
executes. The automated `repository_dispatch` path resolves the environment to
empty and runs unattended. The provenance gate applies identically, so even an
approved manual run cannot pin a tag whose prod image does not exist.

This is a privileged recovery operation, **not** a routine path — use it only
to replay a genuinely-dropped dispatch.

## Rollback (`git revert`)

To roll prod back to the prior version, `git revert` the bump commit on
`cloud-provisioning:main`:

```bash
git -C cloud-provisioning revert <bump-commit-sha>   # restores the prior newTag + label
git -C cloud-provisioning push origin main           # (requires the human up-to-date/PR path)
```

The prior version's tag is already in prod AR (immutable, locked), so ArgoCD
re-syncs to the locked prior digest with no registry-side action. Note that a
human revert push obeys branch protection (PR + up-to-date), unlike the bot's
bypass — so open a one-line revert PR if pushing as a human. See also the
"Rollback to a prior version" subsection below.

## AR rejection behavior

The AR API enforces tag immutability at the `docker push` / `gcloud artifacts docker tags add` boundary. The relevant error responses:

| Operation | Response |
|---|---|
| Push a fresh tag (`:v1.0.1` on a never-existing tag) | 200 OK / success |
| Push the same digest under an existing tag (idempotent re-tag, same bytes) | 200 OK (some clients short-circuit before contacting API) |
| Push a different digest under an existing tag (re-point) | **HTTP 409 Conflict** — error message references "tag already exists" or "immutable tags" |
| Delete a tag | Allowed (immutable-tags blocks RE-POINTING, not deletion) |

The 409 surface in `docker/build-push-action@v5` looks like:
```
ERROR: failed to push asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/server:v1.0.0:
unexpected http response 409: ... tag already exists in immutable repository ...
```

This is **expected and desired** when the policy is working. A 409 on a tag push attempt means "this tag is already locked at the current digest; you cannot silently overwrite it".

## Automation setup (one-time)

The `automate-prod-pin-bump` pipeline depends on four pieces of GitHub
configuration. The Pulumi-managed pieces live in `src/github/` and apply on a
prod `pulumi up`; the rest are documented here because they require an
out-of-band credential or a setting GitHub does not expose to this provider
version.

### 1. Cross-repo dispatch credential (GitHub App) — backend + frontend

The release workflows trigger `repository_dispatch` against `cloud-provisioning`
with a **GitHub App installation token** (short-lived, auditable) rather than a
long-lived PAT. The `POST /repos/{owner}/{repo}/dispatches` API requires
`Contents: write` (no narrower scope exists), so the security boundary is NOT
the token scope — it is branch protection (see §2): the token cannot push to
`cloud-provisioning:main` because only `github-actions[bot]` bypasses, so its
reach is limited to non-`main` refs ArgoCD does not track.

One-time setup:
1. Create a GitHub App in the `liverty-music` org (Settings → Developer settings
   → GitHub Apps → New). Permissions: **Repository → Contents: Read and write**
   (the documented minimum for the dispatches API). No webhook needed.
2. Install it on **`cloud-provisioning` only** (scope the installation).
3. Generate a private key; note the App ID.
4. Store the App ID and private key in Pulumi ESC so they are wired as the
   backend + frontend `prod` environment secrets `PROD_PIN_DISPATCH_APP_ID` /
   `PROD_PIN_DISPATCH_APP_PRIVATE_KEY` (consumed by the `dispatch-prod-pin` job
   via `actions/create-github-app-token`):
   ```bash
   esc env set liverty-music/prod pulumiConfig.github.prodPinDispatchAppId "<app-id>"
   esc env set liverty-music/prod pulumiConfig.github.prodPinDispatchAppPrivateKey "$(cat app-private-key.pem)" --secret
   ```
   Then run a prod `pulumi up`; `GitHubRepositoryComponent` creates the two
   environment secrets on backend + frontend (no-op if the config is absent).
5. **Verify the reach is bounded**: confirm a token minted by this App CANNOT
   push to `cloud-provisioning:main` (branch protection denies it) — only its
   `repository_dispatch` trigger should succeed.

### 2. `cloud-provisioning:main` branch-protection bypass for the bot

`bump-prod-pin.yml` pushes the validated bump straight to `main` as
`github-actions[bot]` using the built-in `GITHUB_TOKEN`. For that push to be
accepted, `github-actions[bot]` MUST be a **bypass actor** on the `main`
protection, covering BOTH the pull-request requirement AND the "require branches
up to date" check.

This is **IaC-managed** in `src/github/components/repository.ts`: for
cloud-provisioning prod, the `main` protection is expressed as a
`github.RepositoryRuleset` (not the classic `github.BranchProtection`) with the
GitHub Actions integration (`slug: github-actions`, resolved via the
`getGithubApp` data source) as an `always` **bypass actor**. Classic branch
protection has no per-actor bypass for the strict (up-to-date) status check —
only a ruleset `bypassActors` entry can grant it — which is why
cloud-provisioning's protection uses a ruleset while the other repos stay on
classic `BranchProtection`. The ruleset replicates the prior rules (PR required,
0 approvals; strict `CI Success`; no force-push; no deletion) and applies to
everyone except the single Actions-app bypass actor; **no human and no PAT** is
added.

> **Migration note.** A prod `pulumi up` will **delete** the classic
> `cloud-provisioning-protection` `BranchProtection` and **create** the
> `cloud-provisioning-main-ruleset`. Review the `pulumi preview` diff before
> applying; the swap is a replace, so `main` is briefly governed by whichever
> of the two exists during the apply — apply attended.

Verify after apply: a bot push from `bump-prod-pin.yml` lands on `main` without
a PR; a human direct push to `main` is still rejected (PR + up-to-date required).

### 3. `prod-pin` GitHub Environment (admin reviewer) — cloud-provisioning

The `workflow_dispatch` manual fallback is gated behind the `prod-pin`
Environment with a required-reviewer (admin) rule, bound **only** on the manual
trigger via the conditional `environment:` expression in `bump-prod-pin.yml`.
This Environment is Pulumi-managed in `src/github/` (created on the prod stack);
the required reviewer is the org admin. Verify by test: a `workflow_dispatch`
run pauses for approval; a `repository_dispatch` run does NOT.

## Recovery procedures

### Re-running a GitHub Release workflow that partially failed

Common: GHA infrastructure flake mid-push, workflow re-runs.

**Idempotent path (same bytes):** Re-run succeeds. `docker/build-push-action` re-builds (deterministic-ish for same git SHA), pushes succeed because the digest matches the existing tag. **AR does not reject** because the digest is the same.

**Non-idempotent path (digest diverged):** Re-run fails with 409. This usually means build-time non-determinism (timestamps in image layers, dependency churn). **Do NOT try to work around it.** Cut a new patch version:
1. Tag a new release `v1.0.2` with a no-op commit (e.g., `chore: bump release` in CHANGELOG).
2. Bump prod overlay to `v1.0.2`.

### Accidental manual `gcloud artifacts docker tags add` rejected

If an operator tries:
```bash
gcloud artifacts docker tags add \
  asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/server@sha256:<digest-A> \
  asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/server:v1.0.0
```
and `v1.0.0` currently resolves to digest B, the API rejects. **Do not search for a workaround.** The policy is functioning correctly.

If the goal was to roll back, see "Rollback" below. If the goal was to fix a bad release, cut a new patch version.

### Rollback to a prior version

The prior version's tag is already in AR (immutable, locked). To roll back:
1. Open a PR on `cloud-provisioning` flipping `newTag: v1.0.1` → `newTag: v1.0.0` (and `app.kubernetes.io/version: "1.0.1"` → `"1.0.0"`) in both overlays.
2. Merge. ArgoCD reconciles. Prod Pods restart pulling the locked `:v1.0.0` image bytes.

No registry-side action needed. Immutable-tags has no effect on rollback because the rollback target was already published (and locked) under its own semver.

### Genuine emergency requiring tag re-point (lab-only escape hatch)

This SHOULD never be needed in normal operation. The scenario is something like: a compromised upstream dependency was discovered in `v1.0.0` after release, and the team wants to force-replace the `v1.0.0` tag content rather than cut a new tag (e.g., because external systems pinned to the exact name `v1.0.0`).

The escape hatch:
1. Open a PR on `cloud-provisioning` flipping `dockerConfig.immutableTags: true` → `false` in `src/gcp/index.ts` for the relevant repo.
2. Operator-attended `pulumi up --stack prod`. (No automated apply on prod.)
3. Re-tag via `gcloud artifacts docker tags add` (or via a new GHA push).
4. Open a follow-up PR flipping `immutableTags: false` → `true`. Apply.
5. **Mandatory**: write a post-incident review documenting (a) why the escape hatch was used, (b) what supply-chain compromise required force-replace, (c) what controls would prevent recurrence.

The escape hatch SHALL NOT be used for routine ops (failed rebuilds, typos, "want to fix the release notes"). Cut a new patch version for all of those.

## Retag failure recovery (frontend + backend, post-`promote-prod-image-via-retag` / `backend-symmetric-retag`)

After the `promote-prod-image-via-retag` change lands (live as of 2026-05-18 for frontend) and the `backend-symmetric-retag` change lands (extending the same pattern to the 4-image backend matrix), the prod release path no longer runs `docker build` — it resolves the dev AR digest for `github.sha` and copies it to prod AR via `crane copy` (from `google/go-containerregistry`, installed by `imjasonh/setup-crane`). The proposal's original choice of `gcloud artifacts docker tags add` was inverted during implementation: the gcloud command only renames tags **within a single repository** despite its argument shape, so cross-project copy fails with `Image <src-FQDN> does not match image <dst-FQDN>`. See `openspec/changes/promote-prod-image-via-retag/design.md` D1 (post-archive: `openspec/specs/prod-image-pipeline/spec.md`) for the full post-mortem. This section covers the failure modes specific to the retag flow.

As of OpenSpec change `guarantee-dev-image-per-main-commit`, both push-path workflows dropped their `paths:` trigger gate: every push to `main` runs, and a per-run "build vs inherit" decision guarantees that **every `main` commit has a resolvable dev `:<sha>` image** (built when a build-relevant file changed, otherwise inherited from the parent tip's digest). This makes "any `main` commit is releasable" a true invariant, so a release cut on `main` HEAD always resolves — the old "release failed because HEAD was a doc-only / filtered commit" failure mode is eliminated. The invariant is self-seeding: the commit that edits the workflow file itself matches the build glob set, so it takes the build path and re-establishes the chain.

### Backend matrix dimension (4 parallel jobs)

The backend `deploy.yml` runs the retag inside a strategy matrix over `{server, consumer, concert-discovery, artist-image-sync}`, so on a release event each of the failure modes below can manifest **per matrix entry**. Operator-side handling:

- **`strategy.fail-fast: false`** is set on `build-and-push`, so one failing matrix entry does NOT cancel the other 3. Partial success is the expected steady state when a transient failure hits a subset of the 4 images.
- **Per-entry re-run**: `gh run rerun --job <job-id>` (the workflow-run UI exposes the per-matrix-entry job ID). This re-runs ONLY the failed matrix entry; the 3 that already succeeded are not re-executed and their prod-AR tags are not touched.
- **Re-run safety**: `crane copy` to a prod-AR tag that already exists at the same digest is a **no-op** (HTTP 200, not 409 Conflict) — the AR `immutableTags: true` policy rejects tag-overwrites only when the destination digest would change. Verified empirically during the frontend rollout: the v1.0.2 cutover's PR #363 run executed `crane copy` against an already-populated prod AR and returned 200 OK because the source digest matched the existing destination digest. So a re-run of an already-succeeded backend matrix entry is harmless; a re-run of the failed entry attempts the copy fresh.
- **Cloud-provisioning kustomize bump gating**: the prod overlay PR that bumps `k8s/namespaces/backend/overlays/prod/kustomization.yaml`'s 4× `newTag:` to `vN+1` MUST wait until ALL 4 matrix entries have succeeded for that release. If only 3/4 retag tags exist in prod AR, ArgoCD will fail the sync for the missing Deployment with `ImagePullBackOff`. This is operator-checklist-enforced, not CI-enforced, in the initial rollout.

The three failure modes below apply to ANY individual matrix entry, not the workflow run as a whole — substitute the matrix's `<image-name>` for the frontend's literal `web-app` in commands.

### Failure: dev AR `:<sha>` does not exist

**Symptom**: the "Resolve dev AR digest" workflow step retries 6 times (initial + 5 retries × 60 s) and fails with:

```
::error::dev AR tag :<sha> not resolved after 6 attempts (~5 min total wait).
Given the every-main-commit-has-an-image invariant, the push-path build/inherit
for this commit is still in-flight or failed — do NOT re-target an earlier commit.
```

**Causes** — as of OpenSpec change `guarantee-dev-image-per-main-commit`, every `main` commit has a resolvable dev `:<sha>` image (the push-path either builds it, or, for a commit that changed no build-relevant file, *inherits* the parent tip's digest onto `:<sha>`). So the **previously most-common cause — "the release was cut on a doc-only / `paths:`-filtered commit that produced no image" — no longer occurs**: there is no longer a `paths:` trigger gate, and filtered commits get an inherited image. The remaining causes are:
- **Most likely**: the release was cut seconds after the merge-to-main and the push-path build/inherit job is still in-flight when the 5-minute retry budget expired. The retry budget already absorbs the typical build/inherit completion time.
- **The push-path job for that commit failed** (build error, or an inherit step that could not resolve a parent digest — see the broken-chain note below).
- **Merge-train cancellation**: `concurrency: { cancel-in-progress: false }` protects the in-progress run but NOT an already-pending one — GitHub keeps a single pending run per group and cancels it when a newer run queues. So 3+ `main` pushes inside one run's duration can leave an intermediate push's run **cancelled**, and that commit without a `:<sha>` image. The latest push tip (what a release targets) still runs, so this usually only surfaces as a broken-chain error on a *subsequent* doc-only push that inherits from the cancelled commit. Recovery: `gh run rerun` the cancelled push's `Deploy <repo>` run, or push a build-relevant seed (same as the broken-chain note). Not expected under the current no-auto-merge + up-to-date branch protection (merges are spaced wider than a run); revisit if a merge queue is adopted.
- **Edge case**: the release `target_commitish` is a non-main SHA. The workflow's "Verify release commit is on main" step should catch this earlier — if you reach the digest-resolve step with a non-main SHA, something else broke.

**Recovery**:
1. Check the push-path `Deploy <repo>` run for the same commit SHA — for frontend: `gh run list --repo liverty-music/frontend --branch main --workflow push-image.yaml --limit 10`; for backend: `gh run list --repo liverty-music/backend --branch main --workflow deploy.yml --limit 10`. If it is still in-flight, wait and `gh run rerun --job <job-id>` the failed release matrix entry once it completes. **Do NOT re-target the release to an earlier commit** — main HEAD always has (or will have) an image; re-targeting is the old workaround that this change made unnecessary.
2. If the push-path job for that SHA **failed**, fix the failure and re-run that run (push-path) so the `:<sha>` (built or inherited) lands in dev AR, then re-run the release matrix entry. For the backend matrix, only the failing matrix entry's dev `:<sha>` needs to be (re-)produced — the other 3 entries' tags from the original push are still resolvable.
3. **Broken inherit chain**: if the push-path job failed because an inherit step could not resolve its parent digest (`Cannot resolve parent dev image … :<before> after 3 attempts`), the parent push for that image genuinely failed and left a gap. By design there is **no tag fallback** (inheriting `:main`/`HEAD^1` could pin non-equivalent bytes), so the gapped commit cannot be retroactively given a correct image. Seed the chain by pushing any build-relevant change (frontend: a `src/**` / `package.json` edit; backend: any `**.go` / `go.mod` edit) to `main` — that forces a fresh build and re-establishes the chain from that commit onward. Then **re-cut the release on the new HEAD** (which now has a valid image). The originally-targeted SHA stays imageless; that is expected — releases target HEAD, and HEAD now resolves. (If the resolve failure was instead `Auth failure … (dev AR read)`, it is an IAM/transient issue, not a chain gap — see the IAM section below; do not seed.)
4. If the dev `:<sha>` IS in AR and the digest-resolve step still failed, the IAM grant likely regressed — see "Cross-project IAM grant revoked" below.

### Failure: cross-project IAM grant revoked accidentally

**Symptom**: the "Resolve dev AR digest" workflow step fails immediately with a `PERMISSION_DENIED` from `gcloud artifacts docker images describe`, or a "Promote dev AR digest to prod AR" step fails with a 403 from `crane copy` while reading the dev AR source image (typically surfaced as `DENIED: Permission "artifactregistry.repositories.downloadArtifacts" denied on resource "projects/liverty-music-dev/…"`). Note: this is a **read-side** failure against dev AR — the bindings `prod-ci-frontend-ar-reader` and `prod-ci-backend-ar-reader` grant `roles/artifactregistry.reader` on the dev `frontend` and `backend` AR repos respectively. An `uploadArtifacts` denial on prod AR would indicate a different, separate failure (prod CI SA missing writer on prod AR) outside the scope of these bindings.

**Cause**: the `prod-ci-<repo>-ar-reader` resource (`gcp.artifactregistry.RepositoryIamMember`) was removed from dev project IAM. Most likely a manual `gcloud artifacts repositories remove-iam-policy-binding` invocation, or a `pulumi destroy` that targeted the resource. For the backend matrix specifically, a missing `prod-ci-backend-ar-reader` fails ALL 4 matrix entries identically at digest-resolve — the symmetry is a useful tripwire (single-entry failures indicate a different cause).

**Recovery**:
1. Verify the binding's absence for the affected `<repo>` (`frontend` or `backend`): `gcloud artifacts repositories get-iam-policy <repo> --project=liverty-music-dev --location=asia-northeast2 --format=json | jq '.bindings[] | select(.members[] | contains("github-actions@liverty-music-prod"))'`. Empty output confirms the missing grant.
2. Re-apply via Pulumi Cloud Deployments — the dev stack auto-applies `src/**` changes on merge to `main` via the automated job, so the cleanest re-trigger is to either (a) wait for the next legitimate PR to land or (b) push an empty no-op commit and merge it, OR (c) trigger the dev stack run manually from the [Pulumi Cloud console](https://app.pulumi.com/pannpers/liverty-music/dev/deployments). Any of those recreates `prod-ci-frontend-ar-reader` and `prod-ci-backend-ar-reader` from `src/gcp/index.ts`. **Do not run `pulumi up --stack dev` locally** — it conflicts with the automated job (see `cloud-provisioning/CLAUDE.md`).
3. The next release will succeed once the binding is restored (no `gcloud` cache to invalidate; `gcloud artifacts` queries are live).

### Failure: immutable-tag re-publish rejected (HTTP 409)

**Symptom**: a "Promote dev AR digest to prod AR" step fails with HTTP 409 from `crane copy`, surfaced as `ALREADY_EXISTS: name 'projects/liverty-music-prod/.../tags/vX.Y.Z' already exists` (or equivalent AR error).

**Cause**: this is the `prod-image-tag-immutability` capability working as designed. The `:vX.Y.Z` tag was already published in a previous release event and points at a different digest; AR refuses to re-point it. Most likely the operator:
- Deleted the GitHub Release for `vX.Y.Z`, made a code change, and re-cut the release with the same tag name (the new dev SHA → new digest → conflict on `crane copy`).
- Or, less commonly, the same commit was rebuilt non-deterministically and now has two distinct dev AR digests.

**Recovery**:
- **Always** cut a new patch version (`v1.0.2` becomes `v1.0.3`). Do NOT delete the published tag in prod AR; the immutability is the whole point. Re-publishing the same name is an explicit anti-pattern.
- If you genuinely need to roll back, update the kustomize prod overlay's `newTag:` to the older version's tag — the older immutable tag still resolves to its original digest.
- For a true emergency tag re-point (compromised upstream dep), use the "Genuine emergency requiring tag re-point" escape hatch above. The retag flow's recovery is identical to the rebuild flow's recovery for this failure mode.

## Related

- Spec: `openspec/specs/prod-image-tag-immutability/spec.md` (post-archive) or the in-flight change at `openspec/changes/enable-prod-ar-immutable-tags/`.
- Pulumi enforcement: `src/gcp/index.ts` (`gcp.artifactregistry.Repository` with `dockerConfig.immutableTags`).
- Kustomize overlays: `k8s/namespaces/{backend,frontend}/overlays/prod/kustomization.yaml`.
- Companion runbook: `revoke-cross-project-ar-iam.md` — closes the IAM side of the prod-image-only invariant.
