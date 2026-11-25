-- One row per backend log line marked for analytics (labels.sink =
-- "analytics", backend pkg/analyticslog). `app` is the workload that wrote it.
SELECT
  timestamp,
  DATE(timestamp, 'Asia/Tokyo') AS day_jst,
  JSON_VALUE(labels['topic']) AS topic,
  JSON_VALUE(labels['k8s-pod/app']) AS app,
  severity,
  JSON_VALUE(json_payload['msg']) AS msg,
  json_payload
FROM `{{project}}.logs_analytics._AllLogs`
WHERE JSON_VALUE(labels['sink']) = 'analytics'
