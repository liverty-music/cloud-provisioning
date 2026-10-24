# PostHog BigQuery export

PostHog project 190464 (`liverty-music-prod`, EU cloud) writes its events and persons into the `posthog_raw` dataset of `liverty-music-prod` every hour. Pulumi manages both sides, except one integration that only PostHog's UI can create.

- **PostHog side**:
  - **Integration (made once by hand)**: a `google-cloud-service-account` integration that impersonates `posthog-export`. No API key can create one. PostHog withholds `integration:write` from personal API keys, and project secret API keys accept a short allowlist that does not include it. Pulumi finds the integration by its service account email. See "Creating the integration".
  - **Exports (Pulumi)**: [`src/posthog/components/warehouse-export.ts`](../../src/posthog/components/warehouse-export.ts) defines two hourly batch exports, `BigQuery events` into `posthog_raw.events` and `BigQuery persons` into `posthog_raw.persons`, with `use_json_type` on. The PostHog Terraform provider has no batch export resource, so these are dynamic resources that call the PostHog REST API ([`src/posthog/dynamic/batch-export.ts`](../../src/posthog/dynamic/batch-export.ts)).
- **Google Cloud side**: [`src/gcp/components/analytics-warehouse.ts`](../../src/gcp/components/analytics-warehouse.ts). It holds:
  - the dataset `posthog_raw` (asia-northeast1)
  - the service account `posthog-export`. Its description carries `posthog:<organization id>`, which PostHog checks.
  - `roles/bigquery.jobUser` on the project, and `roles/bigquery.dataEditor` on `posthog_raw` only
  - `roles/iam.serviceAccountTokenCreator` and `roles/iam.serviceAccountViewer` on `posthog-export` for PostHog's account `posthog-batch-exports@posthog-external.iam.gserviceaccount.com`. No key exists.

Reference: <https://posthog.com/docs/data-pipelines/batch-exports/bigquery>.

## The API key

The exports use the management key (`posthogManagementApiKey` in ESC `liverty-music/prod`, see [frontend-error-tracking.md](frontend-error-tracking.md#the-management-key)). The key needs these scopes, limited to project 190464:

- **Integration: Read**, to find the integration
- **Batch export: Write**

Without them, the preview fails with `GET integrations/ failed (403)`, or `pulumi up` fails with `POST batch_exports/ failed (403)`. To add them, edit the key in PostHog (avatar → **Settings → Personal API keys**). The key value stays the same, so ESC needs no change.

## Creating the integration

Do this once, after the prod `pulumi up` has created `posthog-export` and its grants (`AnalyticsWarehouseComponent`), and before the `pulumi up` that creates the exports.

1. In PostHog (EU cloud, project `liverty-music-prod`), open **Data pipelines → Destinations**, click **+ New destination**, search for **BigQuery** and click **+ Create**.
2. In the connection field, choose **Configure new Google Cloud service account**.
3. Choose **Impersonate service account**, enter:
   - Service account email: `posthog-export@liverty-music-prod.iam.gserviceaccount.com`
   - Project ID: `liverty-music-prod`

   Then save. PostHog checks the account's description here.
4. Close the destination form without creating it. The integration stays; Pulumi creates the exports.

Until the integration exists, the preview fails with `... has no google-cloud-service-account integration for posthog-export@...`. If it is deleted, the exports stop. Create it again the same way; the next `pulumi up` finds the new one and updates the exports.

## What is exported

- **`perf.*` events are left out.** Performance telemetry is read in PostHog. The events export sets `exclude_events`, and PostHog matches the names exactly, not as a pattern. A new `perf.*` event must be added to `PERFORMANCE_EVENTS` in `warehouse-export.ts`. PostHog's UI shows this field only for S3 and Redshift, but the API applies it to every destination.
- **`ip` is empty.** The BigQuery export cannot drop a column. The project discards client IPs at ingestion (project settings → **Discard client IP data**, `anonymize_ips: true`). Keep that setting on.

PostHog creates each table on its first run, at the start of the next hour. The events table is partitioned by day on `timestamp`.

## Verify

After the first hourly run:

```bash
bq --project_id=liverty-music-prod query --use_legacy_sql=false \
  'SELECT COUNT(*) AS rows, COUNTIF(ip IS NOT NULL AND ip != "") AS rows_with_ip,
          COUNTIF(STARTS_WITH(event, "perf.")) AS perf_rows
   FROM posthog_raw.events WHERE DATE(timestamp) >= CURRENT_DATE() - 1'
```

`rows` must be above 0, and `rows_with_ip` and `perf_rows` must be 0.

The export's free tier is 1M rows a month. Check the monthly count:

```bash
bq --project_id=liverty-music-prod query --use_legacy_sql=false \
  'SELECT DATE_TRUNC(DATE(timestamp), MONTH) AS month, COUNT(*) AS rows
   FROM posthog_raw.events GROUP BY month ORDER BY month'
```

## Troubleshooting

- **Saving the integration fails with an error about the service account.** PostHog checks the account's description when the integration is created. Check it:

  ```bash
  gcloud --configuration=liverty-music iam service-accounts describe \
    posthog-export@liverty-music-prod.iam.gserviceaccount.com --format='value(description)'
  ```

  The description must end in `posthog:019e7b58-75ff-0000-79de-62f6f9ec2075`.
- **A run fails with a permission or impersonation error.** Check that PostHog's account holds both roles on `posthog-export`:

  ```bash
  gcloud --configuration=liverty-music iam service-accounts get-iam-policy \
    posthog-export@liverty-music-prod.iam.gserviceaccount.com
  ```

- **The grant to PostHog's account is rejected with `Error 412`.** The organization enforces `iam.allowedPolicyMemberDomains`. The project's override (allow all) must stay in place.
- **An export was changed or deleted in PostHog's UI.** The dynamic resources do not read the export back, so neither `pulumi preview` nor `pulumi refresh` shows the drift. If an export was changed, change any field in code, or replace the resource with `pulumi up --target <urn> --replace <urn>`, to send the configuration again. If it was deleted, run `pulumi state delete <urn>` and then `pulumi up` to create it again. Agents write these commands out for the user and do not run them on prod.

## Stopping the export

Remove `WarehouseExport` from `src/index.ts` and run `pulumi up`. This deletes both exports in PostHog. The `posthog_raw` tables stay. To delete the integration as well, delete it in PostHog's UI.
