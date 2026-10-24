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

- **Where**: <https://eu.posthog.com/project/190464/insights/SBk3xMle> (tag `north-star`).
- **Changing it**: edit the `queryJson` of `posthog-product-analytics-north-star` in code. A change made in the UI is overwritten by the next `pulumi up`.
- **When it shows data**: `notification.opened` carries `type` only after these releases:
  - the frontend service worker change of `expand-product-analytics` (liverty-music/frontend#837)
  - the backend push data change of the same change (liverty-music/backend#685)

  Until both are out, the insight shows 0.

## Data Studio reports

Build each report on the listed mart views in `liverty-music-prod`. Use the **owner's credentials** as the data source credentials, and set the date range control on the view's date column (`day_jst` or `month`). Then fill in the URL below.

| report | URL | views | what it shows |
|---|---|---|---|
| Unit economics | <https://datastudio.google.com/reporting/ae44debc-ccdd-41f3-b194-a3e57e128594> | `mart_unit_economics_monthly`, `mart_cost_per_concert_monthly` | Total cost per active and per retained fan by month. Gemini cost per new concert and per new ticket sale. |
| Gemini cost | <https://datastudio.google.com/reporting/ff600878-b9f8-4d70-87a4-b8f17ce3ba7d> | `mart_gemini_cost_daily` | Daily cost stacked by `process` and `search`, with list and billed cost. |
| Infrastructure cost | <https://datastudio.google.com/reporting/ee86ca81-aeba-42b9-aa1e-3ef3147a1c6b> | `mart_infra_cost_daily` | Daily cost by `service` and GKE `namespace`. |
| Campaign value | <https://datastudio.google.com/reporting/c417d531-6dce-4764-ad5e-64c6a7e33411> | `mart_campaign_value` | Sign-ups, retained fans and paid orders by first `utm_source` / `utm_campaign`. |
| Pipeline health | <https://datastudio.google.com/reporting/433f590f-a0a5-4d20-9410-e8b2ec53f53e> | `mart_pipeline_health_daily` | One chart per `area`: job runs and failures by job, notification outcomes by type, review queue in and out. Filter on `area` and `metric`. |

### Building or rebuilding a report

These steps follow Google's Data Studio docs as of 2026-10-24 ("Create a new report", "Connect to BigQuery", "Data source credentials", "Date range control"). The docs did not show every label, so some steps below come from the editor itself.

1. At <https://datastudio.google.com>, click **Create** → **Report**. The **Add data to report** panel opens.
2. On **Connect to data**, choose **BigQuery** and pick the source:
   - **MY PROJECTS** → `liverty-music-prod`
   - Dataset `analytics_marts`
   - Table: the mart view
3. Before **Add**, open **Data credentials** and keep **Owner's credentials**. Then viewers need no BigQuery role. Click **Add**.
4. Add the report's other views with **Add data** in the toolbar.
5. Add charts with **Add a chart** and fill them in the chart's **Setup** panel. Two settings make the daily marts readable:
   - **Group by week or month.** Change the type of the `day_jst` dimension, through the calendar icon on its chip, to ISO Year Week or Year Month. Single days are dominated by the days the searches run.
   - **Stack by metric.** A stacked bar chart stacks only when the chart has several series. Either use two metrics (for example `token_net_cost` and `search_query_net_cost`), or use one metric with a breakdown dimension that has more than one value.
6. Add **Add a control** → **Date range control**. Set each chart's **Date Range Dimension** to `day_jst` or `month`.
7. Name the report as in the table above, and put its URL there.

Until `$ai_generation` arrives (backend#685, released in v1.102.0 on 2026-10-24), a breakdown by `process` or `search` shows only `(unattributed)`.

Ad-hoc questions: open a mart view in Data Studio and use Conversational Analytics. It bills BigQuery compute only.

### Checks

- **Gemini cost matches the bill.** The month's sum of `mart_gemini_cost_daily.net_cost` equals the `Gemini API` cost in the raw billing export. September 2026 gave 6,424.88 JPY in the mart, in the raw export (cost + credits, JST days) and for `invoice.month = 202609`. The mart sums to the bill by construction. Once generations arrive (from 2026-10-25), also check that `(unattributed)` stays small.
- **Scan size.** `mart_infra_cost_daily` reads the whole detailed billing export, about 0.7 GB per load in 2026-10. If it is opened often, materialize it before the free 1 TiB of queries a month is at risk.
