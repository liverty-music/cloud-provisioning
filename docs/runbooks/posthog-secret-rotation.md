# Runbook: rotate PostHog API keys

> **Background:** the OpenSpec change `introduce-analytics-tool` provisions
> two PostHog API keys in GCP Secret Manager — the public project key
> (used by frontend bundles and the backend `analytics-consumer`) and the
> personal API key (used by backend local-evaluation flag sync). Both
> keys are scoped to the PostHog Cloud EU project and have no expiry
> from PostHog's side; rotation is driven by our policy or by suspected
> exposure.

## When to use this runbook

Use this when any of the following is true:

- A scheduled 6-monthly rotation is due.
- The public project key has appeared in a public source (e.g. checked
  into a git repository, leaked through a tracking-link share).
- The personal API key has appeared anywhere outside Secret Manager.
- A team member with PostHog admin access has left and held the
  previously generated keys.

This runbook is **not** for routine application restarts; both keys are
fetched at process start and at SDK init, so a rotation requires either
a scheduled cycle or a forced restart of the affected workloads.

## Prerequisites

You must have:

- `IAM_OWNER`-equivalent access on the GCP project (`liverty-music-dev`,
  `liverty-music-staging`, and `liverty-music-prod`), or at least
  `roles/secretmanager.admin` on each.
- PostHog admin access to the EU Cloud project at
  `https://eu.posthog.com/project/<project-id>/settings/project-api-keys`.
- `gcloud` authenticated against each target environment.
- Push access to `liverty-music/cloud-provisioning` (to land any Pulumi
  changes that reference new key version names).

## Step 1 — issue replacement keys in PostHog

1. Log into PostHog Cloud EU and switch to the Liverty Music project.
2. Navigate to **Settings → Project → Project API key**.
3. For the public project key:
   - Click **Reset project API key**. Capture the new key value
     immediately — PostHog does not display it again.
   - The old key remains accepted for a 24-hour grace window during
     which you should complete steps 2 through 4.
4. For the personal API key:
   - Navigate to **Account → Personal API Keys**.
   - Create a new key labelled `liverty-music-<env>-rotation-<YYYYMMDD>`
     with scope `feature_flag:read` and `event:write`.
   - Capture the value immediately.
5. Do NOT yet delete the old keys in PostHog — leave them active until
   step 4 confirms the new ones are live.

## Step 2 — write the new keys to Secret Manager

For each environment in order — `dev`, then `staging`, then `prod`:

```sh
# Public project key
echo -n "<new-public-key>" | gcloud secrets versions add \
  posthog-public-project-key \
  --project=liverty-music-<env> \
  --data-file=-

# Personal API key
echo -n "<new-personal-key>" | gcloud secrets versions add \
  posthog-personal-api-key \
  --project=liverty-music-<env> \
  --data-file=-
```

The previous version remains as the immediate fallback but is no longer
the latest, which is what application code reads by default.

## Step 3 — roll the dependent workloads

Both keys are read once per process at startup, so the new versions take
effect after restart. Roll the workloads with ArgoCD-aware deployment
operations rather than `kubectl delete pod`:

```sh
# Backend analytics-consumer (Deployment name to be confirmed in Batch 2b;
# follow the established `<workload>-app` convention used by server-app /
# consumer-app under k8s/namespaces/backend/base/).
kubectl --context=liverty-music-<env> -n backend \
  rollout restart deployment analytics-consumer-app

# Backend Connect-RPC server (uses the personal key for flag sync)
kubectl --context=liverty-music-<env> -n backend \
  rollout restart deployment server-app

# Frontend public key is injected via runtime-config Lambda;
# trigger a new bundle deploy if the env value lives outside Secret Manager,
# or re-issue the runtime config refresh otherwise.
```

Wait for `rollout status` to confirm before moving to the next
environment.

## Step 4 — verify the new keys are in use

1. Tail backend logs and confirm the `analytics-consumer` reports
   successful PostHog calls with the new key version:
   ```sh
   gcloud --project=liverty-music-<env> logging read \
     'resource.labels.container_name="analytics-consumer" AND severity>=INFO' \
     --limit=20 --freshness=10m
   ```
2. In PostHog → **Settings → API key usage**, confirm traffic against
   the new key value appears within the past few minutes.
3. In PostHog → **Activity**, confirm a non-zero event rate is being
   accepted in real time.
4. Confirm flag sync in the backend: a structured log line of the form
   `feature flags refreshed count=<n>` SHALL be emitted within the
   configured sync interval after the new pod starts.

## Step 5 — revoke the old keys

Once steps 3 and 4 are green in every environment:

1. In PostHog **Settings → Project API key**, the public key has
   already been reset (step 1); no further action.
2. In PostHog **Account → Personal API Keys**, delete the old
   personal key.
3. Optionally, disable the older Secret Manager versions to reduce
   the chance of accidental rollback to the old key:
   ```sh
   gcloud secrets versions disable <version-number> \
     --secret=posthog-personal-api-key \
     --project=liverty-music-<env>
   ```

## Step 6 — record the rotation

Open or update the existing rotation tracker issue in
`liverty-music/cloud-provisioning` with:

- The date.
- The trigger (scheduled / suspected exposure / departure).
- The new Secret Manager version numbers per environment.
- The next scheduled rotation date (today + 6 months).

## Rollback

If verification in step 4 fails before step 5 completes:

1. Identify the previous version number for each secret:

   ```sh
   gcloud secrets versions list posthog-public-project-key \
     --project=liverty-music-<env>

   gcloud secrets versions list posthog-personal-api-key \
     --project=liverty-music-<env>
   ```

   The previous good version is the one immediately preceding the one
   added in step 2 of this runbook (look at the `CREATED` timestamps).

2. Re-enable the previous Secret Manager version for both secrets:

   ```sh
   gcloud secrets versions enable <prev-version-number> \
     --secret=posthog-public-project-key \
     --project=liverty-music-<env>

   gcloud secrets versions enable <prev-version-number> \
     --secret=posthog-personal-api-key \
     --project=liverty-music-<env>
   ```

3. Confirm the previous value is now accessible (the command prints the
   secret payload — redirect to a file or run in a private terminal):

   ```sh
   gcloud secrets versions access <prev-version-number> \
     --secret=posthog-public-project-key \
     --project=liverty-music-<env>

   gcloud secrets versions access <prev-version-number> \
     --secret=posthog-personal-api-key \
     --project=liverty-music-<env>
   ```

4. Restart the workloads again so the pods pick up the previous version
   (use the same `kubectl rollout restart` commands from step 3 of the
   main procedure).

5. Investigate the failure before retrying the rotation.

If verification fails AFTER step 5 (old keys revoked), there is no
clean rollback — issue a fresh pair of keys via step 1 and re-run from
step 2.
