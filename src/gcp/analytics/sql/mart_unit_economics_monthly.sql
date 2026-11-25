-- Total cloud cost of this project per retained fan, by JST month; dev cost
-- is left out because dev serves no fan. A retained fan is a person
-- with activity in at least 2 distinct weeks (Monday start) of the month.
-- Pipeline events without a person are not activity.
WITH activity AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    person_id,
    COUNT(DISTINCT DATE_TRUNC(day_jst, WEEK(MONDAY))) AS active_weeks
  FROM `{{project}}.analytics_staging.stg_events`
  WHERE has_person AND person_id IS NOT NULL
  GROUP BY month, person_id
),
fans AS (
  SELECT
    month,
    COUNT(*) AS active_fans,
    COUNTIF(active_weeks >= 2) AS retained_fans
  FROM activity
  GROUP BY month
),
cost AS (
  SELECT
    DATE_TRUNC(day_jst, MONTH) AS month,
    SUM(net_cost) AS net_cost,
    SUM(list_cost) AS list_cost
  FROM `{{project}}.analytics_staging.stg_billing_daily`
  WHERE project_id = '{{project}}'
  GROUP BY month
)
SELECT
  month,
  c.net_cost,
  c.list_cost,
  IFNULL(f.active_fans, 0) AS active_fans,
  IFNULL(f.retained_fans, 0) AS retained_fans,
  SAFE_DIVIDE(c.net_cost, f.active_fans) AS net_cost_per_active_fan,
  SAFE_DIVIDE(c.net_cost, f.retained_fans) AS net_cost_per_retained_fan
FROM cost AS c
LEFT JOIN fans AS f USING (month)
