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

### 1. Build + publish prod image (in `liverty-music/backend` or `liverty-music/frontend`)

1. Merge release-bound PRs to `main`.
2. From the GitHub UI: **Releases → Draft a new release → Tag = `v1.0.1`** (next patch) → Publish.
3. GitHub Actions (`deploy.yml` for backend, `push-image.yaml` for frontend) fires on the `release: published` event:
   - Authenticates to prod via Workload Identity Federation (`github-actions@liverty-music-prod.iam`).
   - Builds the image.
   - Pushes with **two tags**: `:v1.0.1` and `:<commit-sha>`.
4. Wait for both pushes to succeed. Verify via:
   ```bash
   gcloud artifacts docker images list \
     asia-northeast2-docker.pkg.dev/liverty-music-prod/backend \
     --include-tags --filter='package~server' --limit=5
   ```
   The new digest SHOULD appear with both `:v1.0.1` and the SHA as tags.

### 2. Bump the prod kustomize overlay (in `liverty-music/cloud-provisioning`)

1. Open a PR on `cloud-provisioning` updating both:
   - `k8s/namespaces/backend/overlays/prod/kustomization.yaml` — bump `newTag: v1.0.0` → `newTag: v1.0.1` for all four backend images, AND bump the corresponding inline comment SHA. Also bump the `labels:` block's `app.kubernetes.io/version: "1.0.1"`.
   - `k8s/namespaces/frontend/overlays/prod/kustomization.yaml` — bump `newTag:` + comment + `app.kubernetes.io/version` for `web-app` if frontend was part of the release.

   ⚠️ **`v`-prefix gotcha**: `newTag:` SHALL use the `v` prefix (`v1.0.1`) because that's the AR-side tag convention. `app.kubernetes.io/version:` SHALL be the bare semver (`"1.0.1"`, no `v`) because that's the Kubernetes Recommended Labels convention. Two different conventions in two adjacent fields of the same overlay — common bump-time mistake. The verification step below catches it.

2. Run locally before pushing:
   ```bash
   # Check every rendered image carries the new semver tag
   kubectl kustomize k8s/namespaces/backend/overlays/prod | grep -E 'image:.*:v[0-9]+\.[0-9]+\.[0-9]+'

   # Check every label has a bare-semver value (no `v` prefix slip)
   kubectl kustomize k8s/namespaces/backend/overlays/prod | grep -E 'app\.kubernetes\.io/version: "?v' && echo "FAIL: v-prefix in label value" || echo "OK: label values are bare semver"
   ```
   Confirm every rendered image carries `:v1.0.1` and every label is `app.kubernetes.io/version: "1.0.1"` (no `"v1.0.1"`).
3. Open PR, get review, merge.

### 3. ArgoCD reconciles

ArgoCD detects the cloud-provisioning `main` change and rolls the prod Deployments / CronJobs with the new `image:` reference and `app.kubernetes.io/version` label. Pods restart; image bytes resolve via the AR tag → digest lookup.

### 4. Verify

```bash
kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
    -n backend get deploy,cronjob -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}'
```

All images SHALL end with `:v1.0.1`.

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

## Retag failure recovery (frontend, post-`promote-prod-image-via-retag`)

After the `promote-prod-image-via-retag` change lands, the frontend release path no longer runs `docker build` — it resolves the dev AR digest for `github.sha` and copies it to prod AR via `gcloud artifacts docker tags add`. This section covers the three failure modes specific to the retag flow.

### Failure: dev AR `:<sha>` does not exist

**Symptom**: the "Resolve dev AR digest" workflow step retries 6 times (initial + 5 retries × 60 s) and fails with:

```
::error::dev AR tag :<sha> not found after 6 attempts (~5 min total wait).
Either the dev build for this commit failed, or the release was cut on a non-main commit.
```

**Causes**:
- **Most likely**: the release was cut on a commit whose dev build failed or was filtered out (e.g., a doc-only commit that didn't trigger the `Deploy Frontend` workflow's `paths:` filter — see `frontend/.github/workflows/push-image.yaml`).
- **Less likely**: the release was cut seconds after the merge-to-main and the dev push was still in-flight when the 5-minute retry budget expired. Almost always: the dev build is slower than expected; the retry budget already absorbs the typical 60–180 s ArgoCD Image Updater poll.
- **Edge case**: the release `target_commitish` is a non-main SHA. The workflow's "Verify release commit is on main" step should catch this earlier — if you reach the digest-resolve step with a non-main SHA, something else broke.

**Recovery**:
1. Check the dev `Deploy Frontend` run for the same commit SHA: `gh run list --repo liverty-music/frontend --branch main --workflow push-image.yaml --limit 10`. If the dev build failed, fix the failure and push to `main`. Then either re-run the existing release (`gh release delete vX.Y.Z` then `gh release create vX.Y.Z --target <new-sha>`) or cut a new patch.
2. If the dev build was skipped entirely (paths filter), make a trivial commit that DOES match the filter (e.g., bump `package.json`'s patch version), push, wait for the dev image to land in dev AR, then re-cut the release on the new SHA.
3. If the dev build IS in AR and the digest-resolve step still failed, the IAM grant likely regressed — see "Cross-project IAM grant revoked" below.

### Failure: cross-project IAM grant revoked accidentally

**Symptom**: the "Resolve dev AR digest" workflow step fails immediately with a `PERMISSION_DENIED` from `gcloud artifacts docker images describe`, or the `gcloud artifacts docker tags add` step fails with a 403.

**Cause**: the `prod-ci-frontend-ar-reader` resource (`gcp.artifactregistry.RepositoryIamMember`) was removed from dev project IAM. Most likely a manual `gcloud artifacts repositories remove-iam-policy-binding` invocation, or a `pulumi destroy` that targeted the resource.

**Recovery**:
1. Verify the binding's absence: `gcloud artifacts repositories get-iam-policy frontend --project=liverty-music-dev --location=asia-northeast2 --format=json | jq '.bindings[] | select(.members[] | contains("github-actions@liverty-music-prod"))'`. Empty output confirms the missing grant.
2. Re-apply via Pulumi Cloud Deployments — the dev stack auto-applies `src/**` changes on merge to `main` via the automated job, so the cleanest re-trigger is to either (a) wait for the next legitimate PR to land or (b) push an empty no-op commit and merge it, OR (c) trigger the dev stack run manually from the [Pulumi Cloud console](https://app.pulumi.com/pannpers/liverty-music/dev/deployments). Any of those recreates `prod-ci-frontend-ar-reader` from `src/gcp/index.ts`. **Do not run `pulumi up --stack dev` locally** — it conflicts with the automated job (see `cloud-provisioning/CLAUDE.md`).
3. The next release will succeed once the binding is restored (no `gcloud` cache to invalidate; `gcloud artifacts` queries are live).

### Failure: immutable-tag re-publish rejected (HTTP 409)

**Symptom**: the `gcloud artifacts docker tags add ... :vX.Y.Z` step fails with `tags.add: ALREADY_EXISTS` / HTTP 409 / "tag already exists".

**Cause**: this is the `prod-image-tag-immutability` capability working as designed. The `:vX.Y.Z` tag was already published in a previous release event and points at a different digest; AR refuses to re-point it. Most likely the operator:
- Deleted the GitHub Release for `vX.Y.Z`, made a code change, and re-cut the release with the same tag name (the dev rebuild produced a new SHA → new digest → conflict on tag-add).
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
