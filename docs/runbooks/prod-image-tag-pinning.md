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

## Related

- Spec: `openspec/specs/prod-image-tag-immutability/spec.md` (post-archive) or the in-flight change at `openspec/changes/enable-prod-ar-immutable-tags/`.
- Pulumi enforcement: `src/gcp/index.ts` (`gcp.artifactregistry.Repository` with `dockerConfig.immutableTags`).
- Kustomize overlays: `k8s/namespaces/{backend,frontend}/overlays/prod/kustomization.yaml`.
- Companion runbook: `revoke-cross-project-ar-iam.md` — closes the IAM side of the prod-image-only invariant.
