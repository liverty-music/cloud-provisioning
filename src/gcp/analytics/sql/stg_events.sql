-- One row per PostHog event. The export appends, so a retried run can write
-- an event twice: keep the latest copy of each uuid. perf.* is excluded by the
-- export; the filter here catches a new perf.* name not yet on its list.
SELECT
  uuid AS event_id,
  event,
  timestamp,
  DATE(timestamp, 'Asia/Tokyo') AS day_jst,
  distinct_id,
  person_id,
  -- Pipeline events (EnqueueSystem) have no fan behind them.
  IFNULL(LAX_BOOL(properties['$process_person_profile']), TRUE) AS has_person,
  properties
FROM `{{project}}.posthog_raw.events`
WHERE NOT STARTS_WITH(event, 'perf.')
QUALIFY ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY bq_ingested_timestamp DESC) = 1
