# PostHog BigQuery export

How PostHog project 190464 (`liverty-music-prod`, EU cloud) writes its events and persons into the `posthog_raw` dataset of `liverty-music-prod`, hourly.

## Why this is a runbook (not Pulumi)

PostHog batch exports are configured in PostHog. The PostHog MCP connection cannot create them (it lacks `batch_export:write`). The Google Cloud side is managed in Pulumi in [`src/gcp/components/analytics-warehouse.ts`](../../src/gcp/components/analytics-warehouse.ts):

- the dataset `posthog_raw` (asia-northeast1)
- the service account `posthog-export`. Its description carries `posthog:<organization id>`, which PostHog checks before it exports.
- `roles/bigquery.jobUser` on the project, and `roles/bigquery.dataEditor` on `posthog_raw` only
- `roles/iam.serviceAccountTokenCreator` and `roles/iam.serviceAccountViewer` on `posthog-export` for PostHog's account `posthog-batch-exports@posthog-external.iam.gserviceaccount.com`. With these two roles PostHog impersonates `posthog-export`, and no key exists.

Reference: <https://posthog.com/docs/data-pipelines/batch-exports/bigquery>.

## Prerequisites

`pulumi up` has run on prod with the `AnalyticsWarehouseComponent`. Check:

```bash
bq --project_id=liverty-music-prod show --format=prettyjson posthog_raw | grep '"location"'
gcloud --configuration=liverty-music iam service-accounts describe \
  posthog-export@liverty-music-prod.iam.gserviceaccount.com --format='value(description)'
```

The first command prints `"location": "asia-northeast1"`. The second prints a description that ends in `posthog:019e7b58-75ff-0000-79de-62f6f9ec2075`.

## Procedure

Create two exports in PostHog, one for the events model and one for the persons model. Both use these settings:

| field | value |
|---|---|
| Authentication | Service account impersonation |
| Service account email | `posthog-export@liverty-music-prod.iam.gserviceaccount.com` |
| Project ID | `liverty-music-prod` |
| Dataset ID | `posthog_raw` |
| Frequency | Hourly |
| Use JSON type | on |

The exports differ in two fields:

| export | Model | Table ID |
|---|---|---|
| events | Events | `events` |
| persons | Persons | `persons` |

Steps:

1. In PostHog (EU cloud, project `liverty-music-prod`), open **Data pipelines → Destinations** and click **+ New destination**.
2. Search for **BigQuery** and click **+ Create**.
3. Fill in the fields above for the events export and click **Create**.
4. Repeat steps 1 to 3 for the persons export.

PostHog creates each table on its first run, at the start of the next hour. The events table is partitioned by day on `timestamp`.

### What cannot be left out

The BigQuery destination has no event filter and no column selection (2026-10-24). Two consequences:

- **`ip`**: the project discards client IPs at ingestion (project settings → **Discard client IP data**, `anonymize_ips: true`), so the exported `ip` is empty. Keep that setting on.
- **`perf.*` events**: they are exported, and the staging views drop them. They are most of the volume, so watch the row count (see "Verify").

If the creation form offers an **Events to exclude** field, set it to the `perf.*` events and note it here.

## Verify

After the first hourly run:

```bash
bq --project_id=liverty-music-prod query --use_legacy_sql=false \
  'SELECT COUNT(*) AS rows, COUNTIF(ip IS NOT NULL AND ip != "") AS rows_with_ip
   FROM posthog_raw.events WHERE DATE(timestamp) >= CURRENT_DATE() - 1'
```

`rows` must be above 0, and `rows_with_ip` must be 0.

The export's free tier is 1M rows a month. Check the monthly count:

```bash
bq --project_id=liverty-music-prod query --use_legacy_sql=false \
  'SELECT DATE_TRUNC(DATE(timestamp), MONTH) AS month, COUNT(*) AS rows,
          COUNTIF(STARTS_WITH(event, "perf.")) AS perf_rows
   FROM posthog_raw.events GROUP BY month ORDER BY month'
```

If the count is on track to pass 1M, choose one of two fixes. You can sample `perf.*` in the frontend, or move the events export to the S3-compatible destination on GCS, which supports **Events to exclude**.

## Troubleshooting

- **The run fails with a permission or impersonation error.** Check that the service account description still contains `posthog:<organization id>`. Also check that PostHog's account holds both roles on `posthog-export`:

  ```bash
  gcloud --configuration=liverty-music iam service-accounts get-iam-policy \
    posthog-export@liverty-music-prod.iam.gserviceaccount.com
  ```

- **The grant to PostHog's account is rejected with `Error 412`.** The organization enforces `iam.allowedPolicyMemberDomains`. The project's override (allow all) must stay in place.

## Stopping the export

Pause or delete both exports in PostHog. The `posthog_raw` tables stay. To also revoke access, remove the two `serviceaccount.IAMMember` resources for PostHog's account from the component.
