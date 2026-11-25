-- One row per request to the Gemini search model ($ai_generation).
-- `search` tells the two searchers apart by their request: a published-sale
-- search names its series, a concert search its start date.
SELECT
  event_id,
  timestamp,
  day_jst,
  JSON_VALUE(properties['process']) AS process,
  CASE
    WHEN properties['series_ids'] IS NOT NULL THEN 'ticket_sale'
    WHEN properties['search_from'] IS NOT NULL THEN 'concert'
    ELSE 'other'
  END AS search,
  JSON_VALUE(properties['$ai_model']) AS model,
  JSON_VALUE(properties['app_version']) AS app_version,
  JSON_VALUE(properties['$ai_trace_id']) AS trace_id,
  IFNULL(LAX_INT64(properties['$ai_input_tokens']), 0) AS input_tokens,
  IFNULL(LAX_INT64(properties['$ai_output_tokens']), 0) AS output_tokens,
  IFNULL(LAX_INT64(properties['$ai_cache_read_input_tokens']), 0) AS cache_read_input_tokens,
  IFNULL(ARRAY_LENGTH(JSON_QUERY_ARRAY(properties['web_search_queries'])), 0) AS web_search_queries,
  IFNULL(LAX_BOOL(properties['$ai_is_error']), FALSE) AS is_error
FROM `{{project}}.analytics_staging.stg_events`
WHERE event = '$ai_generation'
