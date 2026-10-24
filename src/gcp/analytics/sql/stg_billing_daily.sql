-- Cloud Billing standard export by JST day, service and SKU. `net_cost` is
-- what is billed (cost plus credits, which are negative); `list_cost` is the
-- price before discounts. Amounts are in the billing account's currency (JPY).
SELECT
  DATE(usage_start_time, 'Asia/Tokyo') AS day_jst,
  service.description AS service,
  sku.description AS sku,
  ANY_VALUE(currency) AS currency,
  SUM(cost_at_list) AS list_cost,
  SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS net_cost
FROM `{{project}}.billing_export.gcp_billing_export_v1_{{billing_account}}`
GROUP BY day_jst, service, sku
