-- Cloud cost by JST day, project, service and GKE namespace ('(outside the
-- cluster)' when the cost has no namespace label). Dev stays in, as its own
-- project_id, so its cost is visible next to prod's.
SELECT
  day_jst,
  project_id,
  service,
  IFNULL(namespace, '(outside the cluster)') AS namespace,
  ANY_VALUE(currency) AS currency,
  SUM(list_cost) AS list_cost,
  SUM(net_cost) AS net_cost
FROM `{{project}}.analytics_staging.stg_billing_resource_daily`
GROUP BY day_jst, project_id, service, namespace
