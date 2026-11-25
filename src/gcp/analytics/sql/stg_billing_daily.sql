-- Cloud Billing standard export by JST day, project, service and SKU. The
-- export covers the whole billing account, dev included, so a mart that
-- divides cost by prod activity filters on `project_id`. `net_cost` is
-- what is billed (cost plus credits, which are negative); `list_cost` is the
-- price before discounts. Amounts are in the billing account's currency (JPY).
SELECT
  DATE(usage_start_time, 'Asia/Tokyo') AS day_jst,
  project.id AS project_id,
  service.description AS service,
  sku.description AS sku,
  ANY_VALUE(currency) AS currency,
  SUM(cost_at_list) AS list_cost,
  SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net_cost
FROM `{{project}}.billing_export.gcp_billing_export_v1_{{billing_account}}`
GROUP BY day_jst, project_id, service, sku
