-- Fans by their first campaign (PostHog's $initial_utm_source and
-- $initial_utm_campaign): sign-ups, fans retained in any month (activity in
-- 2 distinct weeks of it), and paid orders. '(none)' is a fan who arrived
-- without a campaign.
WITH retained AS (
  SELECT DISTINCT person_id
  FROM (
    SELECT
      person_id,
      DATE_TRUNC(day_jst, MONTH) AS month,
      COUNT(DISTINCT DATE_TRUNC(day_jst, WEEK(MONDAY))) AS active_weeks
    FROM `{{project}}.analytics_staging.stg_events`
    WHERE has_person AND person_id IS NOT NULL
    GROUP BY person_id, month
  )
  WHERE active_weeks >= 2
),
per_person AS (
  SELECT
    e.person_id,
    COUNTIF(e.event = 'user.created') > 0 AS signed_up,
    COUNTIF(e.event = 'order.paid') AS paid_orders
  FROM `{{project}}.analytics_staging.stg_events` AS e
  WHERE e.has_person AND e.person_id IS NOT NULL
  GROUP BY e.person_id
)
SELECT
  IFNULL(p.first_utm_source, '(none)') AS first_utm_source,
  IFNULL(p.first_utm_campaign, '(none)') AS first_utm_campaign,
  COUNT(*) AS persons,
  COUNTIF(pp.signed_up) AS sign_ups,
  COUNTIF(r.person_id IS NOT NULL) AS retained_fans,
  SUM(IFNULL(pp.paid_orders, 0)) AS paid_orders
FROM `{{project}}.analytics_staging.stg_persons` AS p
LEFT JOIN per_person AS pp USING (person_id)
LEFT JOIN retained AS r USING (person_id)
GROUP BY first_utm_source, first_utm_campaign
