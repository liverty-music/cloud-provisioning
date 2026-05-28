# Enable GCP Billing Export to BigQuery

One-time Console procedure to wire GCP's Billing Export to the
Pulumi-provisioned `billing_export` BigQuery dataset in the
`liverty-music-prod` project.

## Why this is a runbook (not Pulumi)

GCP does not expose an API for the "Billing → Billing export → BigQuery
export" configuration. The dataset itself, its IAM bindings, and the
required APIs are all Pulumi-managed via
[`src/gcp/components/billing-export.ts`](../../src/gcp/components/billing-export.ts).
This runbook covers the remaining Console click-through.

## Prerequisites

- `pulumi up --stack prod` has been run on a commit that includes the
  `BillingExportComponent`. Verify with:
  ```bash
  bq --project_id=liverty-music-prod ls billing_export
  ```
  The command should succeed and return an empty result set (no tables
  yet — they appear after export starts running).
- You have **Billing Account Administrator** or **Billing Account Costs
  Manager** on the billing account that funds `liverty-music-prod`. The
  Project Owner role on the project is **not** sufficient.

## Procedure

### 1. Open the Billing Export configuration

GCP Console → top-left ☰ → **Billing** → left sidebar **Billing export**
→ tab **BigQuery export**.

You should see three rows:
- Standard usage cost
- Detailed usage cost
- Pricing

Each starts as "Not enabled".

### 2. Enable Standard usage cost export

1. Click **Edit settings** on the "Standard usage cost" row.
2. Fill in:
   - **Project:** `liverty-music-prod`
   - **Dataset:** `billing_export`
3. Click **Save**.

The row should flip to "Enabled — exporting to `liverty-music-prod:billing_export`".

### 3. Enable Detailed usage cost export

Repeat step 2 for the "Detailed usage cost" row. The Detailed export
includes per-resource labels and is what makes per-namespace / per-Pod
cost attribution possible.

> **Note:** Detailed export adds a small BigQuery storage cost (~hundreds
> of yen/month at our scale) but is essential for the kind of investigation
> the `prod-cost-optimization` change was motivated by. Keep it enabled.

### 4. (Optional) Enable Pricing export

The Pricing export ships current SKU price lists into BigQuery as a
reference table. Useful for joining usage to current rates without
hitting the Cloud Billing Catalog API. Same procedure as steps 2-3.

### 5. Verify after 24 hours

Billing data lands in BigQuery on a 24-hour delay (sometimes longer for
the first batch). After ~24h, run:

```bash
bq --project_id=liverty-music-prod ls billing_export
```

You should see at least one table:
```
gcp_billing_export_v1_<BILLING_ACCOUNT_ID>
gcp_billing_export_resource_v1_<BILLING_ACCOUNT_ID>   # if Detailed was enabled
cloud_pricing_export                                  # if Pricing was enabled
```

Where `<BILLING_ACCOUNT_ID>` is the billing account ID with hyphens
replaced by underscores.

If no tables appear after 48 hours, proceed to the troubleshooting
section below.

## Sample analysis queries

Drop these into BigQuery Console once data is flowing.

### Daily SKU-level breakdown

```sql
SELECT
  DATE(usage_start_time) AS usage_date,
  service.description AS service,
  sku.description AS sku,
  ROUND(SUM(cost), 0) AS cost_jpy
FROM `liverty-music-prod.billing_export.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`
WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY usage_date, service, sku
ORDER BY usage_date DESC, cost_jpy DESC;
```

### Per-namespace GKE Pod cost (requires Detailed export)

```sql
SELECT
  DATE(usage_start_time) AS usage_date,
  (SELECT value FROM UNNEST(labels) WHERE key = 'k8s-namespace') AS namespace,
  ROUND(SUM(cost), 0) AS cost_jpy
FROM `liverty-music-prod.billing_export.gcp_billing_export_resource_v1_<BILLING_ACCOUNT_ID>`
WHERE service.description = 'Kubernetes Engine'
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
GROUP BY usage_date, namespace
ORDER BY usage_date DESC, cost_jpy DESC;
```

### Identifying a cost-spike day

If a daily cost report shows an unexpected jump, run this to find which
SKU drove it:

```sql
WITH daily AS (
  SELECT
    DATE(usage_start_time) AS d,
    sku.description AS sku,
    SUM(cost) AS c
  FROM `liverty-music-prod.billing_export.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`
  WHERE DATE(usage_start_time) BETWEEN DATE_SUB('<spike_date>', INTERVAL 1 DAY) AND '<spike_date>'
  GROUP BY d, sku
)
SELECT
  sku,
  MAX(IF(d = '<spike_date>', c, 0)) AS spike_day,
  MAX(IF(d != '<spike_date>', c, 0)) AS baseline_day,
  MAX(IF(d = '<spike_date>', c, 0))
    - MAX(IF(d != '<spike_date>', c, 0)) AS delta
FROM daily
GROUP BY sku
HAVING delta > 0
ORDER BY delta DESC;
```

## Troubleshooting

### No tables appear after 48 hours

1. Confirm the dataset exists:
   ```bash
   bq --project_id=liverty-music-prod ls billing_export
   ```
   If this returns an error, `pulumi up --stack prod` did not run
   successfully. Re-check the Pulumi state and re-apply.
2. Confirm the export configuration is still "Enabled":
   - Console → Billing → Billing export → BigQuery export.
   - If it reverted to "Not enabled", re-do steps 2-3 above.
3. Confirm dataset write permissions:
   - The component grants
     `roles/bigquery.dataEditor` to
     `serviceAccount:cloud-billing-export@system.gserviceaccount.com`.
   - If GCP has renamed this principal since the component was written,
     identify the actual SA used by your billing account:
     - Cloud Console → IAM & Admin → Logs Explorer
     - Filter:
       `protoPayload.serviceName="bigquery.googleapis.com"
        AND protoPayload.resourceName=~"projects/liverty-music-prod/datasets/billing_export"`
     - Look at recent write attempts; the `protoPayload.authenticationInfo.principalEmail`
       field reveals the actual SA.
   - Add the discovered SA to the `BillingExportComponent` IAM binding and
     re-apply.

### Wrong billing account selected

If "Billing → Billing export" shows a different billing account than the
one funding `liverty-music-prod`:

1. Click the billing account dropdown at the top of the Billing console.
2. Switch to the correct one.
3. The BigQuery export tab now shows that billing account's config —
   redo steps 2-3 of the procedure.

### Want to disable

To disable an export, click **Edit settings** on the row and click
**Disable**. The dataset remains; only the inbound data flow stops.
Existing tables are preserved.

To remove the dataset entirely, revert the
`BillingExportComponent` instantiation in
[`src/gcp/index.ts`](../../src/gcp/index.ts) and run
`pulumi up --stack prod`. Pulumi will refuse if tables exist; either
empty the dataset first or override with `--force`.
