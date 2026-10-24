# Analytics dashboards

Where to read the analytics warehouse (OpenSpec `build-analytics-warehouse`): the Data Studio reports built on the mart views, and the North Star insight in PostHog.

## Where each piece is managed

| piece | managed in | why |
|---|---|---|
| Datasets, views (`analytics_staging`, `analytics_marts`) | Pulumi, [`src/gcp/components/analytics-warehouse.ts`](../../src/gcp/components/analytics-warehouse.ts), SQL in [`src/gcp/analytics/sql/`](../../src/gcp/analytics/sql/) | |
| North Star insight | Pulumi, `posthog.Insight` in [`src/posthog/components/product-analytics.ts`](../../src/posthog/components/product-analytics.ts) | |
| Data Studio reports | by hand, listed below | Data Studio has no API to create or edit a report. Its Linking API only opens a copy of an existing one. |

## North Star

**Fans who opened a new-concert notification, per week.** It counts unique persons per week with `notification.opened` where `type = new_concerts`, test accounts excluded, over the last 180 days.

- **Where**: in PostHog, Product analytics → Insights, tag `north-star`.
- **Changing it**: edit the `queryJson` of `posthog-product-analytics-north-star` in code. A change made in the UI is overwritten by the next `pulumi up`.
- **When it shows data**: `notification.opened` carries `type` only after these releases:
  - the frontend service worker change of `expand-product-analytics` (liverty-music/frontend#837)
  - the backend push data change of the same change (liverty-music/backend#685)

  Until both are out, the insight shows 0.

## Data Studio reports

Build each report on the listed mart views in `liverty-music-prod`. Use the **owner's credentials** as the data source credentials, and set the date range control on the view's date column (`day_jst` or `month`). Then fill in the URL below.

| report | URL | views | what it shows |
|---|---|---|---|
| Unit economics | _to be added_ | `mart_unit_economics_monthly`, `mart_cost_per_concert_monthly` | Total cost per active and per retained fan by month. Gemini cost per new concert and per new ticket sale. |
| Gemini cost | _to be added_ | `mart_gemini_cost_daily` | Daily cost stacked by `process` and `search`, with list and billed cost. |
| Infrastructure cost | _to be added_ | `mart_infra_cost_daily` | Daily cost by `service` and GKE `namespace`. |
| Campaign value | _to be added_ | `mart_campaign_value` | Sign-ups, retained fans and paid orders by first `utm_source` / `utm_campaign`. |
| Pipeline health | _to be added_ | `mart_pipeline_health_daily` | One chart per `area`: job runs and failures by job, notification outcomes by type, review queue in and out. Filter on `area` and `metric`. |

Ad-hoc questions: open a mart view in Data Studio and use Conversational Analytics. It bills BigQuery compute only.

### Checks

- **Gemini cost matches the bill.** For one full month after backend#685 is released, the month's sum of `mart_gemini_cost_daily.net_cost` equals the `Gemini API` net cost in `analytics_staging.stg_billing_daily`. The mart always sums to the bill by construction; the check confirms that `(unattributed)` is small once generations arrive.
- **Scan size.** `mart_infra_cost_daily` reads the whole detailed billing export, about 0.7 GB per load in 2026-10. If it is opened often, materialize it before the free 1 TiB of queries a month is at risk.
