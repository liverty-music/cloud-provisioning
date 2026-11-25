-- Cloud Billing detailed (resource-level) export by JST day, project, service
-- and GKE namespace; `namespace` is null for cost outside the cluster. The
-- export covers the whole billing account, dev included.
SELECT
  DATE(usage_start_time, 'Asia/Tokyo') AS day_jst,
  project.id AS project_id,
  service.description AS service,
  (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'k8s-namespace') AS namespace,
  ANY_VALUE(currency) AS currency,
  SUM(cost_at_list) AS list_cost,
  SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net_cost
FROM `{{project}}.billing_export.gcp_billing_export_resource_v1_{{billing_account}}`
GROUP BY day_jst, project_id, service, namespace
