-- Gemini cost per new concert and per new ticket sale, by JST month.
-- New concerts: published straight from discovery (concert.ingest.completed
-- `published_count`) plus those a reviewer approved (the catalog_review log
-- line's `inserted`). New sales: ticket_sale.search.completed `new_count`.
WITH cost AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    SUM(IF(search = 'concert', net_cost, 0)) AS concert_search_net_cost,
    SUM(IF(search = 'concert', list_cost, 0)) AS concert_search_list_cost,
    SUM(IF(search = 'ticket_sale', net_cost, 0)) AS ticket_sale_search_net_cost,
    SUM(IF(search = 'ticket_sale', list_cost, 0)) AS ticket_sale_search_list_cost,
    SUM(IF(search NOT IN ('concert', 'ticket_sale'), net_cost, 0)) AS unattributed_net_cost
  FROM `{{project}}.analytics_marts.mart_gemini_cost_daily`
  GROUP BY month
),
published AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    SUM(IFNULL(LAX_INT64(properties['published_count']), 0)) AS published
  FROM `{{project}}.analytics_staging.stg_events`
  WHERE event = 'concert.ingest.completed'
  GROUP BY month
),
approved AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    SUM(IFNULL(LAX_INT64(json_payload['inserted']), 0)) AS approved
  FROM `{{project}}.analytics_staging.stg_log_lines`
  WHERE topic = 'catalog_review' AND msg = 'concert candidate approved and published'
  GROUP BY month
),
sales AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    SUM(IFNULL(LAX_INT64(properties['new_count']), 0)) AS new_sales
  FROM `{{project}}.analytics_staging.stg_events`
  WHERE event = 'ticket_sale.search.completed'
  GROUP BY month
)
SELECT
  month,
  IFNULL(p.published, 0) + IFNULL(a.approved, 0) AS new_concerts,
  IFNULL(s.new_sales, 0) AS new_sales,
  c.concert_search_net_cost,
  c.concert_search_list_cost,
  c.ticket_sale_search_net_cost,
  c.ticket_sale_search_list_cost,
  c.unattributed_net_cost,
  SAFE_DIVIDE(c.concert_search_net_cost, IFNULL(p.published, 0) + IFNULL(a.approved, 0)) AS net_cost_per_new_concert,
  SAFE_DIVIDE(c.concert_search_list_cost, IFNULL(p.published, 0) + IFNULL(a.approved, 0)) AS list_cost_per_new_concert,
  SAFE_DIVIDE(c.ticket_sale_search_net_cost, s.new_sales) AS net_cost_per_new_sale,
  SAFE_DIVIDE(c.ticket_sale_search_list_cost, s.new_sales) AS list_cost_per_new_sale
FROM cost AS c
FULL OUTER JOIN published AS p USING (month)
FULL OUTER JOIN approved AS a USING (month)
FULL OUTER JOIN sales AS s USING (month)
