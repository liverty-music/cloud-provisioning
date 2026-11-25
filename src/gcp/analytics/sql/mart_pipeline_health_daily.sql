-- Scheduled jobs, notification delivery and the concert review queue by JST
-- day, from the backend's analytics log lines. One row per (day, area, name,
-- metric), so a report filters on `area` and `metric`.
--   job:          name = workload; runs, failures (items that failed), circuit_broken.
--                 A run that crashed before its summary line is not counted.
--   notification: name = notification type; delivered, failed, failed:<reason>
--                 (Web Push failures), no_subscription (sales reminders), and
--                 fanout_sent_nothing:<reason> for new-concert fan-outs that
--                 reached nobody.
--   review:       name = 'concert_candidate'; queued (distinct artist, series
--                 and date: a re-discovered candidate logs again), approved,
--                 rejected, reconciled.
WITH lines AS (
  SELECT * FROM `{{project}}.analytics_staging.stg_log_lines`
),
jobs AS (
  SELECT day_jst, 'job' AS area, app AS name, 'runs' AS metric, COUNT(*) AS value
  FROM lines WHERE topic = 'job_result' GROUP BY day_jst, app
  UNION ALL
  SELECT day_jst, 'job', app, 'failures', SUM(IFNULL(LAX_INT64(json_payload['failures']), 0))
  FROM lines WHERE topic = 'job_result' GROUP BY day_jst, app
  UNION ALL
  SELECT day_jst, 'job', app, 'circuit_broken', COUNTIF(IFNULL(LAX_BOOL(json_payload['circuit_broken']), FALSE))
  FROM lines WHERE topic = 'job_result' GROUP BY day_jst, app
),
deliveries AS (
  SELECT
    day_jst,
    CASE
      WHEN msg = 'sales_reminder delivery outcome' THEN 'sales_reminder'
      ELSE JSON_VALUE(json_payload['notification_type'])
    END AS name,
    -- A sales reminder's outcome is delivered, no_subscription or failed.
    CASE
      WHEN msg = 'notification delivered' THEN 'delivered'
      WHEN msg = 'notification delivery failed' THEN 'failed'
      ELSE IFNULL(JSON_VALUE(json_payload['outcome']), 'unknown')
    END AS outcome,
    JSON_VALUE(json_payload['failure_reason']) AS reason
  FROM lines
  WHERE topic = 'notification_delivery'
    AND msg IN ('notification delivered', 'notification delivery failed', 'sales_reminder delivery outcome')
),
notifications AS (
  SELECT day_jst, 'notification' AS area, name, outcome AS metric, COUNT(*) AS value
  FROM deliveries GROUP BY day_jst, name, outcome
  UNION ALL
  SELECT day_jst, 'notification', name, CONCAT('failed:', IFNULL(reason, 'unknown')), COUNT(*)
  FROM deliveries WHERE outcome = 'failed' GROUP BY day_jst, name, reason
  UNION ALL
  SELECT day_jst, 'notification', 'new_concerts', CONCAT('fanout_sent_nothing:', reason), COUNT(*)
  FROM (
    SELECT day_jst, IFNULL(JSON_VALUE(json_payload['reason']), 'unknown') AS reason
    FROM lines
    WHERE topic = 'notification_delivery' AND STARTS_WITH(msg, 'new-concert fan-out sent nothing')
  )
  GROUP BY day_jst, reason
),
review AS (
  SELECT day_jst, 'review' AS area, 'concert_candidate' AS name, 'queued' AS metric,
    COUNT(DISTINCT CONCAT(
      JSON_VALUE(json_payload['artist_id']), '|',
      JSON_VALUE(json_payload['series_id']), '|',
      JSON_VALUE(json_payload['local_date'])
    )) AS value
  FROM lines
  WHERE topic = 'catalog_review'
    AND msg IN (
      'concert candidate with unresolved venue for review',
      'conflicting concert kept as a candidate for reconciliation'
    )
  GROUP BY day_jst
  UNION ALL
  SELECT day_jst, 'review', 'concert_candidate',
    CASE
      WHEN msg = 'concert candidate approved and published' THEN 'approved'
      WHEN msg = 'concert candidate rejected and logged' THEN 'rejected'
      ELSE 'reconciled'
    END,
    COUNT(*)
  FROM lines
  WHERE topic = 'catalog_review'
    AND msg IN (
      'concert candidate approved and published',
      'concert candidate rejected and logged',
      'duplicate reconciled: kept existing event, concert candidate logged and cleared',
      "duplicate reconciled: adopted the candidate's display fields onto existing event"
    )
  GROUP BY day_jst, msg
)
SELECT * FROM jobs
UNION ALL SELECT * FROM notifications
UNION ALL SELECT * FROM review
