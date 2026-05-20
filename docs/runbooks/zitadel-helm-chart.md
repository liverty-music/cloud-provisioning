# Runbook: Zitadel Helm chart maintenance

> **Source of truth:** this runbook is derived from
> `specification/openspec/specs/zitadel-self-hosted-deployment/spec.md` →
> "Zitadel Deployment Rendered by Official Helm Chart" and related
> requirements. If the spec is updated, regenerate this file in the
> same PR.

## What this runbook covers

The Zitadel API + Login V2 UI Deployments are rendered from the
official [`zitadel/zitadel-charts`](https://github.com/zitadel/zitadel-charts)
Helm chart via Kustomize's `helmCharts:` integration. This runbook
covers:

1. How values.yaml is structured (shared base + per-overlay diffs).
2. How to bump the chart version safely.
3. How to verify changes locally before opening a PR.
4. Known chart quirks and how they're handled.

## File layout

```
k8s/namespaces/zitadel/
├── base/
│   ├── values.yaml          ← shared Helm values (image, login.env, jobs, tools, OTEL_*)
│   ├── kustomization.yaml   ← static resources only (NO helmCharts: here)
│   ├── httproute.yaml       ← Gateway routing (chart's gateway templates disabled)
│   ├── healthcheckpolicy.yaml
│   ├── serviceaccount.yaml  ← shared zitadel SA + Workload Identity binding
│   ├── external-secret.yaml ← ESO → K8s Secret `zitadel-masterkey`
│   ├── external-secret-web-pat.yaml
│   ├── external-secret-postgres-admin.yaml
│   └── namespace.yaml
└── overlays/{dev,prod}/
    ├── kustomization.yaml   ← helmCharts: lives here (per-overlay rendering)
    ├── values.yaml          ← env diffs (ExternalDomain, DB IAM user, cloud-sql-proxy connection name + full initContainers list)
    ├── httproute-patch.yaml
    ├── login-probe-patch.yaml   ← re-inject probes after chart's hard-coded paths disabled
    └── …                    ← env-specific resources (CronJob, Jobs, PodMonitoring, etc.)
```

The two overlay `values.yaml` files share structural skeleton; the
diff is `ExternalDomain`, two `Database.Postgres.{User,Admin}.Username`
fields, and the cloud-sql-proxy `liverty-music-{env}:asia-northeast2:postgres-osaka`
arg. The `bootstrap-uploader` sidecar block is identical between envs
but cannot live in `base/values.yaml` because Helm list-merge REPLACES
rather than MERGES on layering.

## Local rendering

Both CI (`Makefile:lint-k8s`) and ArgoCD pass
`--enable-helm --load-restrictor=LoadRestrictionsNone`. For local
verification:

```bash
# Helm v3 needs to be on PATH first — the user's Helm v4 (default on
# their machine) is incompatible with kustomize's helm-shim.
PATH="$HOME/.local/share/mise/installs/helm/3.17.0/linux-amd64:$PATH" \
  kustomize build --enable-helm --load-restrictor=LoadRestrictionsNone \
  k8s/namespaces/zitadel/overlays/dev > /tmp/rendered/zitadel-dev.yaml

# Repeat for prod.
PATH="$HOME/.local/share/mise/installs/helm/3.17.0/linux-amd64:$PATH" \
  kustomize build --enable-helm --load-restrictor=LoadRestrictionsNone \
  k8s/namespaces/zitadel/overlays/prod > /tmp/rendered/zitadel-prod.yaml

# Lint.
kube-linter lint /tmp/rendered --config .kube-linter.yaml
./scripts/check-spot-nodeselector.sh /tmp/rendered
```

Or run the full project lint:

```bash
make lint-k8s
```

## Chart version bump procedure

1. **Identify target version.** Browse
   <https://github.com/zitadel/zitadel-charts/releases> and pick a
   minor or patch release. The chart's Zitadel API image tag is set
   via `image.tag` in our `base/values.yaml` — bumping the chart
   version does NOT auto-bump the image tag; do it explicitly in the
   same PR for traceability.
2. **Update pin** in both overlay `kustomization.yaml` files:
   ```yaml
   helmCharts:
   - name: zitadel
     repo: https://charts.zitadel.com
     version: <new-version>
   ```
3. **Update image tag** in `base/values.yaml` AND `login.image.tag`
   to the matching `vX.Y.Z` (both API and Login UI use the same
   semver tag; see deployment-web comment thread in git history for
   why).
4. **Render + diff** against the pre-bump rendered output to surface
   chart changes (added/removed manifests, schema migrations,
   default value changes):
   ```bash
   # Save the current main HEAD render to compare against.
   git stash
   PATH=... kustomize build ... > /tmp/rendered-before.yaml
   git stash pop
   PATH=... kustomize build ... > /tmp/rendered-after.yaml
   diff -u /tmp/rendered-before.yaml /tmp/rendered-after.yaml | less
   ```
5. **Check chart CHANGELOG** for breaking changes. The Zitadel chart
   occasionally renames values keys or restructures template helpers;
   if a key we depend on moved, the render will silently lose the
   value (Helm doesn't warn on unrecognized keys). Pay attention to:
   - `zitadel.initContainers` semantics (we rely on K8s native
     sidecar pattern with `restartPolicy: Always`)
   - `login.fullnameOverride` — confirmed NOT honored at v9.34.1
     (`_helpers.tpl:38`). If a future chart version starts honoring
     it, the Login UI Deployment name changes from `zitadel-api-login`
     to whatever we set, breaking HTTPRoute backendRefs.
   - `login.{liveness,readiness}ProbePath` — hard-coded in the chart
     at `/ui/v2/login/{healthy,ready}`. We override via
     `overlays/<env>/login-probe-patch.yaml`. If the chart starts
     accepting a values path for these, our Kustomize patch becomes
     vestigial.
6. **PR + dev verify before prod.** Same cutover order as the initial
   migration — see `tasks.md` of the original
   `migrate-zitadel-to-helm-chart` change for the procedure.

## Known chart quirks

### `login.fullnameOverride` is silently ignored

Confirmed at v9.34.1 (`_helpers.tpl:38`):
```
{{- define "zitadel.login.fullname" -}}
{{ include "zitadel.fullname" . | trunc 57 | trimSuffix "-" }}-login
```

The login UI's resource name is always `<zitadel.fullname>-login`
regardless of `login.fullnameOverride`. With our
`fullnameOverride: zitadel-api`, the Login UI resources land as
`zitadel-api-login`. The HTTPRoute backendRef and HealthCheckPolicy
targetRef are wired to this name.

### `zitadel.extraContainers` hangs init/setup Jobs

The chart auto-injects `zitadel.extraContainers` into the API Deployment
AND the init/setup Jobs. A classic sidecar (never-exits process like
`cloud-sql-proxy` or our `bootstrap-uploader`) keeps the Job Pod
running forever, hitting `activeDeadlineSeconds: 300` and failing.

**Workaround:** use `zitadel.initContainers` with
`restartPolicy: Always` instead. This is K8s 1.29+ "native sidecar
container" pattern (KEP-753). Sidecars receive SIGTERM and exit
cleanly when the main container completes in a Job, while still
running alongside the main container in the Deployment.

### `login.{liveness,readiness}ProbePath` are hard-coded

`_helpers.tpl` template helpers hard-code `/ui/v2/login/{healthy,ready}`.
With our `NEXT_PUBLIC_BASE_PATH=/ui/v2` collapse, the actual probe
paths under the new base are `/ui/v2/{healthy,ready}`. We disable
chart probes (`login.{readinessProbe,livenessProbe}.enabled: false`)
and re-inject correct probes via Kustomize
`overlays/<env>/login-probe-patch.yaml`.

### `CUSTOM_REQUEST_HEADERS` is auto-generated; don't override

The chart's `login-config-dotenv` ConfigMap auto-generates:
```
CUSTOM_REQUEST_HEADERS="Host:<ExternalDomain>,X-Zitadel-Public-Host:<ExternalDomain>"
```

`X-Zitadel-Public-Host` is the canonical `PublicHostHeaders` value
(`cmd/defaults.yaml`) that Zitadel reads for instance discovery from
cluster-internal callers. Setting `CUSTOM_REQUEST_HEADERS` inline in
`login.env` would silently override BOTH headers, dropping the
`X-Zitadel-Public-Host`. Don't.

### `DefaultInstance.Features` only applies on new-instance creation

Our existing instance (bootstrapped via prior `FirstInstance` config,
now `FirstInstance.Skip: true`) does NOT auto-pick up changes to
`zitadel.configmapConfig.DefaultInstance.Features.*` on chart redeploy.
Post-cutover, use the instance-features API:

```bash
curl -X POST \
  https://auth.dev.liverty-music.app/zitadel.feature.v2.FeatureService/SetInstanceFeatures \
  -H "Authorization: Bearer <pulumi-admin JWT>" \
  -H "Content-Type: application/json" \
  -d '{"loginV2":{"required":true,"baseUri":"/ui/v2"}}'
```

Verify via the matching `GetInstanceFeatures`.

## Catastrophic restore-from-scratch path

If the Cloud SQL `zitadel` database is wiped (dev shutdown + restore,
or prod disaster recovery), the chart needs to re-bootstrap a fresh
instance:

1. Set `zitadel.configmapConfig.FirstInstance.Skip: false` in
   `base/values.yaml` TEMPORARILY.
2. Deploy. The `bootstrap-uploader` native sidecar will publish a
   fresh admin SA key to GSM `zitadel-machine-key-for-pulumi-admin`.
3. Capture the new admin org ID and update `adminOrgIdMap[env]` in
   `src/zitadel/constants.ts`.
4. Flip `FirstInstance.Skip` back to `true` and redeploy.
5. Call `SetInstanceFeatures(loginV2.baseUri="/ui/v2")` against the
   freshly-bootstrapped instance to re-establish the URL collapse.

See `dev-shutdown-restart.md` for the parallel runbook procedure.
