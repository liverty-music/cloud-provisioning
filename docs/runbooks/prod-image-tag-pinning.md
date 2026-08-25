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
    (backend: 5 images; frontend: 3 web bundles — all retagged from one Release)
  → release workflow emits ONE repository_dispatch (bump-prod-pin) → cloud-provisioning
    (backend: component=backend; frontend: component=frontend — one dispatch per
     release, covering ALL of that component's images)
  → bump-prod-pin.yml: validate payload → provenance gate (crane manifest, all imgs)
                       → no-downgrade guard → yq edit every newTag + version label
                       → (frontend) rewrite fan-web-configmap releaseVersion
                       → kustomize build → commit + push to main as the ci-bot App
  → ArgoCD auto-syncs the prod overlay → Pods roll
```

Each Release emits **exactly one** dispatch. A backend Release pins its four
images (`api`, `consumer`, `concert-discovery`, `artist-image-sync`) in one
atomic commit; a frontend Release pins its three web bundles (`fan-web`,
`admin-console-web`, `organizer-console-web`) in one atomic commit. See "Frontend: one dispatch, three bundles" below for why the frontend
side is a single dispatch (it replaced a broken three-dispatch fan-out).

### 1. Build + publish prod image (in `liverty-music/backend` or `liverty-music/frontend`)

1. Merge release-bound PRs to `main`.
2. From the GitHub UI: **Releases → Draft a new release → Tag = `v1.0.1`** (next patch) → Publish.
3. The release workflow (`deploy.yml` for backend, `push-image.yaml` for frontend) fires on `release: published`:
   - Authenticates to prod via Workload Identity Federation (`github-actions@liverty-music-prod.iam`).
   - Retags the dev-AR digest for `github.sha` into prod AR under `:v1.0.1` and `:<commit-sha>` (`crane copy`, no rebuild). Backend retags its 5-image matrix; frontend retags its three bundles (`fan-web`, `admin-console-web`, `organizer-console-web`) in three parallel jobs.
   - On retag success, the `dispatch-prod-pin` job emits a **single** `repository_dispatch` (`event_type: bump-prod-pin`, `client_payload: { component, tag, sha }`) to `cloud-provisioning` via a short-lived GitHub App token. The frontend `component` is always `"frontend"` — one dispatch covering all three bundles.
   - **All-or-nothing gate**: the frontend `dispatch-prod-pin` job `needs: [build-and-push, build-and-push-admin, build-and-push-organizer]` with **no `always()`**, so the default needs-success gate suppresses the dispatch unless all three bundle retags succeed — an incomplete frontend release is never partially pinned. The backend `deploy.yml` dispatch is likewise gated on **all 5** matrix entries succeeding (`needs.build-and-push.result == 'success'` with `fail-fast: false`), so a partial retag never bumps the pin.

### 2. Automated pin-bump (no manual action)

`bump-prod-pin.yml` in `cloud-provisioning` receives the dispatch and, for the named component:

1. Validates the payload (`component ∈ {backend, frontend}`; `tag` matches `^v[0-9]+\.[0-9]+\.[0-9]+$`) and maps it to the set of image entries it pins:
   - `backend` → `api consumer concert-discovery artist-image-sync` (4 images), bumps the version label.
   - `frontend` → `fan-web admin-console-web organizer-console-web` (all three bundles), bumps the version label (sourced from fan-web) and the `fan-web-configmap.yaml` `releaseVersion`.
2. **Provenance gate** — `crane manifest` every prod-AR image at `:tag` (4 for backend, 3 for frontend). A missing image **aborts before any edit** (fail-closed), rejecting bogus/stale tags and the silent-downgrade path.
3. **No-downgrade guard** — for each target image, compares the incoming `tag` against the current pin; a strictly-lower semver **aborts** unless `allow_rollback=true` (manual trigger only). The automated `repository_dispatch` path never sets `allow_rollback`, so it always fails closed on a backward move.
4. Idempotency — if every target `newTag` already equals `tag`, exits 0 without committing.
5. `yq` edit — rewrites every matched `images[].newTag` + its inline `# commit <sha>` trailer and (for the label-bumping components) the `app.kubernetes.io/version` label (bare semver, no `v`) in lock-step. The two-conventions `v`-prefix gotcha is handled in code: `newTag` keeps the `v`, the label strips it. For `frontend`, it also rewrites `releaseVersion` in `fan-web-configmap.yaml` so the SPA Settings screen shows the new version after the rollout.
6. `kustomize build` of the edited prod overlay — a non-zero build **aborts before push** (replaces the CI gate the manual PR provided).
7. Commits and pushes straight to `main` **as the `liverty-music-ci-bot` App** (fetch-rebase-retry, ≤5 attempts; `concurrency` serialized). No PR. (The push authenticates as ci-bot, the sole `main` ruleset bypass actor — see "Automation setup" §2.)

To watch it: `gh run list --repo liverty-music/cloud-provisioning --workflow bump-prod-pin.yml --limit 5`.

### 3. ArgoCD reconciles

ArgoCD detects the `cloud-provisioning:main` bump commit and rolls the prod Deployments / CronJobs with the new `image:` reference and `app.kubernetes.io/version` label. Pods restart; image bytes resolve via the AR tag → digest lookup.

### 4. Verify

```bash
kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
    -n backend get deploy,cronjob -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}'
```

All backend images SHALL end with `:v1.0.1`. For frontend, all three bundles
(`fan-web`, `admin-console-web`, `organizer-console-web`) SHALL end with the same
tag after a single frontend Release — confirm all three moved in the one bump
commit:

```bash
kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
    -n frontend get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}'
```

Then run the prod smoke:
`gh workflow run push-image.yaml --repo liverty-music/frontend -f smoke_url=https://liverty-music.app`.

### Frontend: one dispatch, three bundles

A frontend Release ships three independently-served web bundles from the same
tag — `fan-web` (consumer SPA, `liverty-music.app`), `admin-console-web`
(`admin.liverty-music.app`), and `organizer-console-web`
(`organizer.liverty-music.app`) — all in AR repo `liverty-music-prod/frontend/`,
each with its own CI build/retag job (`build-and-push`, `build-and-push-admin`,
`build-and-push-organizer`) and its own Deployment/Service/HTTPRoute in the
`frontend` namespace. **All three are fully wired in prod**: all three are pinned
in `k8s/namespaces/frontend/overlays/prod/kustomization.yaml` and rolled out by
ArgoCD.

The release workflow emits **one** `repository_dispatch` with `component:
"frontend"`; `bump-prod-pin.yml` maps that to `IMAGES="fan-web admin-console-web
organizer-console-web"` and rewrites all three `images[].newTag`, the
`app.kubernetes.io/version` label (sourced from fan-web), and the
`fan-web-configmap.yaml` `releaseVersion` **in one atomic commit** (one
`kustomize build`, one push). This mirrors how `component: "backend"` pins its
four images in one dispatch.

**Why one dispatch and not three (the fixed race — OpenSpec change
`batch-frontend-prod-pin-dispatch`).** The previous design emitted **three**
dispatches (`frontend`, `frontend-admin`, `frontend-organizer`), one per bundle.
That fan-out hit a GitHub Actions concurrency-group limitation: under the default
`queue: single`, a group holds at most one *running* + one *pending* run, so when
the third dispatch queued it **evicted the middle pending one** and that bundle
was silently left unpinned. Reproduced on releases **v1.58.0** and **v1.58.1**,
each of which needed a manual recovery bump. Collapsing to a single `frontend`
dispatch removes the fan-out, so the only concurrent writers on the
`bump-prod-pin` group are one backend + one frontend release (running-1 +
pending-1, never a third) — no eviction.

> **Historical note.** The original design also exposed per-console
> `frontend-admin` / `frontend-organizer` component values (each pinning a single
> bundle). They were retained transitionally for one release cycle after the
> single-dispatch cutover and **removed** once v1.59.0 validated the collapsed
> `component: frontend` path (OpenSpec change `batch-frontend-prod-pin-dispatch`
> task 4.4). The only accepted components are now `backend` and `frontend`.

## Manual recovery: `workflow_dispatch` fallback (admin-only)

If a dispatch is dropped (e.g. a transient GitHub outage between the release
workflow and `cloud-provisioning`), the bump never lands. Recover by running
`bump-prod-pin.yml` manually with the same payload:

```bash
gh workflow run bump-prod-pin.yml --repo liverty-music/cloud-provisioning \
  -f component=backend -f tag=v1.0.1 -f sha=<release-commit-sha>
```

The `component` input is a choice of `backend | frontend`. For a dropped
**frontend** dispatch, use `component=frontend` — it re-pins all three bundles
atomically. An intentional rollback additionally needs `-f allow_rollback=true`
(the no-downgrade guard fails closed otherwise).

This path is **admin-gated**: `workflow_dispatch` runs bind the `prod-pin`
GitHub Environment (via the conditional `environment:` expression
`${{ github.event_name == 'workflow_dispatch' && 'prod-pin' || '' }}`), which has
a required-reviewer rule, so the run pauses for admin approval before the bump
executes. The automated `repository_dispatch` path resolves the environment to
empty and runs unattended. The provenance gate AND the no-downgrade guard apply
identically, so even an approved manual run cannot pin a tag whose prod image
does not exist, nor silently roll prod backward.

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
human revert push obeys branch protection (PR + up-to-date), unlike the ci-bot
App's bypass — so open a one-line revert PR if pushing as a human. See also the
"Rollback to a prior version" subsection below.

For a **frontend** bump, one bump commit moves all three bundle pins (+ the
version label + configmap) together, so reverting that single commit rolls all
three back in lock-step. If you only need to roll back one bundle, edit its
single `newTag:` in the overlay by hand instead of reverting the whole commit.

## AR rejection behavior

The AR API enforces tag immutability at the `docker push` / `gcloud artifacts docker tags add` boundary. The relevant error responses:

| Operation | Response |
|---|---|
| Push a fresh tag (`:v1.0.1` on a never-existing tag) | 200 OK / success |
| Push the same digest under an existing tag (idempotent re-tag, same bytes) | 200 OK (some clients short-circuit before contacting API) |
| Push a different digest under an existing tag (re-point) | **HTTP 409 Conflict** — error message references "tag already exists" or "immutable tags" |
| Delete a tag | Allowed (immutable-tags blocks RE-POINTING, not deletion) |

The 409 surface (the release path uses `crane copy`, not `docker push`, but the
AR-side rejection is the same) looks like:
```
ERROR: failed to push asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/api:v1.0.0:
unexpected http response 409: ... tag already exists in immutable repository ...
```

This is **expected and desired** when the policy is working. A 409 on a tag push attempt means "this tag is already locked at the current digest; you cannot silently overwrite it".

## Automation setup (one-time)

The `automate-prod-pin-bump` pipeline depends on four pieces of GitHub
configuration. The Pulumi-managed pieces live in `src/github/` and apply on a
prod `pulumi up`; the rest are documented here because they require an
out-of-band credential or a setting GitHub does not expose to this provider
version.

### 1. Cross-repo dispatch credential (GitHub App `liverty-music-ci-bot`)

The release workflows trigger `repository_dispatch` against `cloud-provisioning`
with a **GitHub App installation token** (short-lived, auditable) rather than a
long-lived PAT. The App is a shared org CI-automation bot (`liverty-music-ci-bot`)
— intentionally named generically so it can be reused for future cross-repo CI
automation at the same trust level, while keeping **least privilege**
(`Contents: write` only, installed on `cloud-provisioning` only). The
`POST /repos/{owner}/{repo}/dispatches` API requires `Contents: write` (no
narrower scope exists), so the security boundary is NOT the token scope. Note
that ci-bot IS the sole `main` ruleset bypass actor (see §2 — it is also the bump
pusher), so unlike the design's original intent this credential CAN move
`cloud-provisioning:main` directly; the effective boundary is therefore the
`prod`-environment scoping (release events only) + the bump's provenance /
no-downgrade gates + cutting the Release as the human gate. See the §2 security
trade-off note. Grow this App's permissions/installs only deliberately; if a
future automation needs materially higher privilege or a different trust
boundary, create a separate App instead.

One-time setup:
1. Register a GitHub App in the `liverty-music` org: **Your organizations →
   Settings → Developer settings → GitHub Apps → New GitHub App**. Name
   `liverty-music-ci-bot`; uncheck **Webhook → Active**; under **Repository
   permissions** set **Contents: Read and write** only; **Where can this app be
   installed? → Only on this account**. Create.
2. **Install App → Only select repositories → `cloud-provisioning` only.**
3. On the App's **General** page, **Generate a private key** (downloads a `.pem`)
   and note the **App ID**.
4. Store the App ID and private key in Pulumi ESC. They are wired as
   `CI_BOT_APP_ID` / `CI_BOT_APP_PRIVATE_KEY` on (a) the backend + frontend
   `prod` **environment** secrets — consumed by the `dispatch-prod-pin` job to
   trigger the dispatch — and (b) the cloud-provisioning **repository** secrets
   — consumed by `bump-prod-pin.yml` to mint the token it pushes the bump to
   `main` with (the bump workflow's `repository_dispatch` path runs with an
   empty `environment:`, so it needs a repo-level secret). All
   via `actions/create-github-app-token`:
   ```bash
   esc env set liverty-music/prod pulumiConfig.github.ciBotAppId "<app-id>"
   esc env set liverty-music/prod pulumiConfig.github.ciBotAppPrivateKey "$(cat liverty-music-ci-bot.*.private-key.pem)" --secret
   ```
   Then run a prod `pulumi up`; `GitHubRepositoryComponent` creates the secrets
   (no-op if the config is absent).
5. **Confirm the bypass scope**: after the ruleset applies (§2), the ci-bot App
   is the sole `main` bypass actor. Note this means ci-bot CAN push to
   `cloud-provisioning:main` (it is the bump pusher) — see the §2 security
   trade-off; verify no human/PAT is on the bypass list.

### 2. `cloud-provisioning:main` ruleset bypass (ci-bot App)

`bump-prod-pin.yml` pushes the validated bump straight to `main` **as the
`liverty-music-ci-bot` App** (it mints a ci-bot installation token via
`actions/create-github-app-token` and pushes with it). For that push to be
accepted, the ci-bot App MUST be a **bypass actor** on the `main` protection,
covering BOTH the pull-request requirement AND the "require branches up to date"
check.

This is **IaC-managed** in `src/github/components/repository.ts`: for
cloud-provisioning prod, the `main` protection is a `github.RepositoryRuleset`
(replacing the classic `github.BranchProtection`) whose sole `always` bypass
actor is the ci-bot App (`actorType: Integration`, `actorId: ciBotAppId`). The
ruleset replicates the prior rules (PR required, 0 approvals; strict
`CI Success`; no force-push; no deletion) and applies to everyone except ci-bot;
**no human and no PAT** is added. Other repos keep classic `BranchProtection`.

**Why ci-bot and not `github-actions[bot]`** (the path we did NOT take): a repo
ruleset rejects the global `github-actions` integration as a bypass actor —
`422 "Actor GitHub Actions integration must be part of the ruleset source or
owner organization"` (it is GitHub-owned, not org-owned). The fix that *would*
keep the built-in `GITHUB_TOKEN` — an **organization** ruleset — requires a
**GitHub Team plan** (`403 "Upgrade to GitHub Team to enable this feature"` on
the Free plan). An org-owned App (ci-bot) passes the repo-ruleset validation, so
the bump pushes as ci-bot instead.

> **Security trade-off (relaxes design D1).** ci-bot is ALSO the cross-repo
> dispatch credential stored on the backend/frontend `prod` environments, so a
> compromised prod release workflow could mint a ci-bot token and push to
> `cloud-provisioning:main` directly — i.e. the dispatch credential CAN now move
> prod, which D1 originally forbade. Mitigations: the ci-bot secrets are scoped
> to the `prod` environment (release events only), the provenance gate still
> blocks bogus tags, and cutting the Release remains the human gate. Accepted
> for a solo-dev org to avoid a second dedicated App. To restore the strict
> boundary, introduce a dedicated push-only App (installed + keyed only on
> cloud-provisioning) as the bypass actor instead of ci-bot.

> **Migration note.** A prod `pulumi up` **deletes** the classic
> `cloud-provisioning-protection` `BranchProtection` and **creates** the
> `cloud-provisioning-main` `RepositoryRuleset`. Review the `pulumi preview`
> diff; apply attended (the swap is a replace).

Verify after apply: a bump push from `bump-prod-pin.yml` lands on `main` without
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
  asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/api@sha256:<digest-A> \
  asia-northeast2-docker.pkg.dev/liverty-music-prod/backend/api:v1.0.0
```
and `v1.0.0` currently resolves to digest B, the API rejects. **Do not search for a workaround.** The policy is functioning correctly.

If the goal was to roll back, see "Rollback" below. If the goal was to fix a bad release, cut a new patch version.

### Rollback to a prior version

The prior version's tag is already in AR (immutable, locked). To roll back:
1. Open a PR on `cloud-provisioning` flipping `newTag: v1.0.1` → `newTag: v1.0.0` (and `app.kubernetes.io/version: "1.0.1"` → `"1.0.0"`) in the affected overlay. For **backend** flip all five `newTag:` entries; for **frontend** flip all three bundle `newTag:` entries plus the `fan-web-configmap.yaml` `releaseVersion`. (Alternatively `git revert` the automated bump commit, which already carries all of these together.)
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

After the `promote-prod-image-via-retag` change lands (live as of 2026-05-18 for frontend) and the `backend-symmetric-retag` change lands (extending the same pattern to the backend image matrix), the prod release path no longer runs `docker build` — it resolves the dev AR digest for `github.sha` and copies it to prod AR via `crane copy` (from `google/go-containerregistry`, installed by `imjasonh/setup-crane`). The proposal's original choice of `gcloud artifacts docker tags add` was inverted during implementation: the gcloud command only renames tags **within a single repository** despite its argument shape, so cross-project copy fails with `Image <src-FQDN> does not match image <dst-FQDN>`. See `openspec/changes/promote-prod-image-via-retag/design.md` D1 (post-archive: `openspec/specs/prod-image-pipeline/spec.md`) for the full post-mortem. This section covers the failure modes specific to the retag flow — they apply per matrix entry / per bundle to any of the backend or frontend release jobs.

As of OpenSpec change `guarantee-dev-image-per-main-commit`, both push-path workflows dropped their `paths:` trigger gate: every push to `main` runs, and a per-run "build vs inherit" decision guarantees that **every `main` commit has a resolvable dev `:<sha>` image** (built when a build-relevant file changed, otherwise inherited from the parent tip's digest). This makes "any `main` commit is releasable" a true invariant, so a release cut on `main` HEAD always resolves — the old "release failed because HEAD was a doc-only / filtered commit" failure mode is eliminated. The invariant is self-seeding: the commit that edits the workflow file itself matches the build glob set, so it takes the build path and re-establishes the chain.

### Backend matrix / frontend bundle dimension (parallel jobs)

The backend `deploy.yml` runs the retag inside a strategy matrix over `{api, consumer, concert-discovery, artist-image-sync, merch-discovery}` (5 images), and the frontend `push-image.yaml` runs three parallel bundle jobs (`build-and-push` → `fan-web`, `build-and-push-admin` → `admin-console-web`, `build-and-push-organizer` → `organizer-console-web`). On a release event each of the failure modes below can manifest **per matrix entry / per bundle job**. Operator-side handling:

- **`strategy.fail-fast: false`** is set on the backend `build-and-push` matrix, so one failing entry does NOT cancel the others. Partial success is the expected steady state when a transient failure hits a subset of the images. (The three frontend bundle jobs are independent jobs, so one failing does not cancel the others either.)
- **Per-entry / per-bundle re-run**: `gh run rerun --job <job-id>` (the workflow-run UI exposes each matrix entry / bundle job ID). This re-runs ONLY the failed job; the ones that already succeeded are not re-executed and their prod-AR tags are not touched.
- **Re-run safety**: `crane copy` to a prod-AR tag that already exists at the same digest is a **no-op** (HTTP 200, not 409 Conflict) — the AR `immutableTags: true` policy rejects tag-overwrites only when the destination digest would change. Verified empirically during the frontend rollout: the v1.0.2 cutover's PR #363 run executed `crane copy` against an already-populated prod AR and returned 200 OK because the source digest matched the existing destination digest. So a re-run of an already-succeeded job is harmless; a re-run of the failed one attempts the copy fresh.
- **Dispatch gating (CI-enforced now)**: the release workflow's `dispatch-prod-pin` job is gated on ALL of its retag jobs succeeding — frontend `needs: [build-and-push, build-and-push-admin, build-and-push-organizer]` (no `always()`), backend on all 5 matrix entries. So a partial retag **suppresses the single dispatch entirely** rather than pinning an incomplete set; `bump-prod-pin.yml`'s provenance gate would in any case abort if any target prod-AR image were missing at `:tag`. Recover by re-running the failed retag job, then manually dispatching the bump (see "Manual recovery" above) once all images exist.

The three failure modes below apply to ANY individual matrix entry / bundle job, not the workflow run as a whole — substitute the job's `<image-name>` (e.g. `api`, `fan-web`, `admin-console-web`, `organizer-console-web`) in commands.

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
2. If the push-path job for that SHA **failed**, fix the failure and re-run that run (push-path) so the `:<sha>` (built or inherited) lands in dev AR, then re-run the release matrix entry / bundle job. For the backend matrix (5 images) or the three frontend bundle jobs, only the failing job's dev `:<sha>` needs to be (re-)produced — the other jobs' tags from the original push are still resolvable.
3. **Broken inherit chain**: if the push-path job failed because an inherit step could not resolve its parent digest (`Cannot resolve parent dev image … :<before> after 3 attempts`), the parent push for that image genuinely failed and left a gap. By design there is **no tag fallback** (inheriting `:main`/`HEAD^1` could pin non-equivalent bytes), so the gapped commit cannot be retroactively given a correct image. Seed the chain by pushing any build-relevant change (frontend: a `src/**` / `package.json` edit; backend: any `**.go` / `go.mod` edit) to `main` — that forces a fresh build and re-establishes the chain from that commit onward. Then **re-cut the release on the new HEAD** (which now has a valid image). The originally-targeted SHA stays imageless; that is expected — releases target HEAD, and HEAD now resolves. (If the resolve failure was instead `Auth failure … (dev AR read)`, it is an IAM/transient issue, not a chain gap — see the IAM section below; do not seed.)
4. If the dev `:<sha>` IS in AR and the digest-resolve step still failed, the IAM grant likely regressed — see "Cross-project IAM grant revoked" below.

### Failure: cross-project IAM grant revoked accidentally

**Symptom**: the "Resolve dev AR digest" workflow step fails immediately with a `PERMISSION_DENIED` from `gcloud artifacts docker images describe`, or a "Promote dev AR digest to prod AR" step fails with a 403 from `crane copy` while reading the dev AR source image (typically surfaced as `DENIED: Permission "artifactregistry.repositories.downloadArtifacts" denied on resource "projects/liverty-music-dev/…"`). Note: this is a **read-side** failure against dev AR — the bindings `prod-ci-frontend-ar-reader` and `prod-ci-backend-ar-reader` grant `roles/artifactregistry.reader` on the dev `frontend` and `backend` AR repos respectively. An `uploadArtifacts` denial on prod AR would indicate a different, separate failure (prod CI SA missing writer on prod AR) outside the scope of these bindings.

**Cause**: the `prod-ci-<repo>-ar-reader` resource (`gcp.artifactregistry.RepositoryIamMember`) was removed from dev project IAM. Most likely a manual `gcloud artifacts repositories remove-iam-policy-binding` invocation, or a `pulumi destroy` that targeted the resource. The binding is per-AR-repo, not per-image: a missing `prod-ci-backend-ar-reader` fails ALL backend matrix entries identically, and a missing `prod-ci-frontend-ar-reader` fails ALL three frontend bundle jobs identically, at digest-resolve — the symmetry is a useful tripwire (single-entry failures indicate a different cause, since all images in one repo share the one reader grant).

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

## Frontend console bundles (fan / admin / organizer)

The `frontend` repo produces **three** independently-served web bundles from one
`npm run build`, each with its own Dockerfile, CI job, image, K8s
Deployment/Service/HTTPRoute (siblings in the `frontend` namespace), and runtime
`/config.json`. **All three are fully wired in prod** — all three are pinned in
`k8s/namespaces/frontend/overlays/prod/kustomization.yaml` and rolled out by
ArgoCD (renamed to `<audience>-console-web` naming by OpenSpec change
`unify-workload-naming`).

| | Fan SPA (consumer) | Admin console | Organizer console |
|---|---|---|---|
| Image | `frontend/fan-web` | `frontend/admin-console-web` | `frontend/organizer-console-web` |
| Build | `Dockerfile` (serves `index.html`, SW, manifest) | `Dockerfile.admin` (serves `admin.html`) | `Dockerfile.organizer` (serves `organizer.html`) |
| Frontend CI job | `build-and-push` | `build-and-push-admin` | `build-and-push-organizer` |
| Hostname | `liverty-music.app` / `dev.liverty-music.app` | `admin.liverty-music.app` | `organizer.liverty-music.app` |
| Runtime config | `fan-web-configmap.yaml` | `admin-console-web-configmap.yaml` | `organizer-console-web-configmap.yaml` |

All three share AR repo `liverty-music-prod/frontend/`. The admin and organizer
consoles are **prod-only** (no dev environment runs them); dev auto-rollout via
ArgoCD Image Updater applies to the fan bundle.

**One Release pins all three.** These bundles do NOT release on independent
cadences at the pin layer: a single frontend GH Release retags all three into
prod AR and emits **one** `repository_dispatch` (`component: "frontend"`), and
`bump-prod-pin.yml` rewrites all three `newTag:` entries + the version label
(sourced from fan-web) + the fan-web `releaseVersion` **in one atomic commit**.
See "Frontend: one dispatch, three bundles" above for the full mechanism and the
concurrency-race history (`batch-frontend-prod-pin-dispatch`) that made batching
mandatory. The former per-console `frontend-admin` / `frontend-organizer`
component values have been removed (task 4.4); `bump-prod-pin.yml` now accepts
only `backend` and `frontend`.

Structurally, each console's prod release is identical to the fan bundle's: GH
Release → retag each bundle's dev-AR digest to prod AR → single
`repository_dispatch` (`component: frontend`) → `bump-prod-pin.yml` pins all three
→ ArgoCD auto-syncs each Deployment. A bundle whose bytes did not change still
gets re-pinned to the new tag (its dev image was inherited byte-identically), so
its Pods roll but serve the same content.

## Related

- Frontend console bundles: OpenSpec changes `add-admin-console`,
  `organizer-console`, and `unify-workload-naming` (the `<audience>-console-web`
  rename); prod bases at `k8s/namespaces/frontend/base/admin-console-web/` and
  `.../base/organizer-console-web/`.
- Batched frontend dispatch: OpenSpec change `batch-frontend-prod-pin-dispatch`
  (collapses the three per-bundle dispatches into one `component: frontend`
  dispatch; fixes the concurrency-group pending-eviction seen on v1.58.0 /
  v1.58.1).
- Spec: `openspec/specs/prod-image-tag-immutability/spec.md` (post-archive) or the in-flight change at `openspec/changes/enable-prod-ar-immutable-tags/`.
- Pulumi enforcement: `src/gcp/index.ts` (`gcp.artifactregistry.Repository` with `dockerConfig.immutableTags`).
- Kustomize overlays: `k8s/namespaces/{backend,frontend}/overlays/prod/kustomization.yaml`.
- Companion runbook: `revoke-cross-project-ar-iam.md` — closes the IAM side of the prod-image-only invariant.
