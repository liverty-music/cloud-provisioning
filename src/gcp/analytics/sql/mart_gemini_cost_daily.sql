-- Gemini API cost of this project by JST day, process and search. Other
-- projects on the billing account (dev) are left out: their calls send no
-- $ai_generation here, so they cannot be split by process. The bill has no process, so
-- each day's token cost is split by each (process, search)'s share of that
-- day's tokens, and the search-query cost by its share of web search queries.
-- A day with no matching generations keeps its cost as '(unattributed)', so
-- the rows of a day always add up to the bill.
WITH cost AS (
  SELECT
    day_jst,
    IF(sku LIKE '%search query%', 'search_query', 'token') AS kind,
    SUM(list_cost) AS list_cost,
    SUM(net_cost) AS net_cost
  FROM `{{project}}.analytics_staging.stg_billing_daily`
  WHERE service = 'Gemini API' AND project_id = '{{project}}'
  GROUP BY day_jst, kind
),
usage AS (
  SELECT
    day_jst,
    process,
    search,
    COUNT(*) AS generations,
    SUM(input_tokens + output_tokens) AS tokens,
    SUM(web_search_queries) AS web_search_queries
  FROM `{{project}}.analytics_staging.stg_ai_generations`
  GROUP BY day_jst, process, search
),
share AS (
  SELECT day_jst, process, search, 'token' AS kind,
    SAFE_DIVIDE(tokens, SUM(tokens) OVER (PARTITION BY day_jst)) AS share
  FROM usage
  WHERE tokens > 0
  UNION ALL
  SELECT day_jst, process, search, 'search_query' AS kind,
    SAFE_DIVIDE(web_search_queries, SUM(web_search_queries) OVER (PARTITION BY day_jst)) AS share
  FROM usage
  WHERE web_search_queries > 0
),
allocated AS (
  SELECT
    c.day_jst,
    IFNULL(s.process, '(unattributed)') AS process,
    IFNULL(s.search, '(unattributed)') AS search,
    c.kind,
    c.list_cost * IFNULL(s.share, 1) AS list_cost,
    c.net_cost * IFNULL(s.share, 1) AS net_cost
  FROM cost AS c
  LEFT JOIN share AS s USING (day_jst, kind)
)
SELECT
  a.day_jst,
  a.process,
  a.search,
  ANY_VALUE(u.generations) AS generations,
  ANY_VALUE(u.tokens) AS tokens,
  ANY_VALUE(u.web_search_queries) AS web_search_queries,
  SUM(IF(a.kind = 'token', a.list_cost, 0)) AS token_list_cost,
  SUM(IF(a.kind = 'token', a.net_cost, 0)) AS token_net_cost,
  SUM(IF(a.kind = 'search_query', a.list_cost, 0)) AS search_query_list_cost,
  SUM(IF(a.kind = 'search_query', a.net_cost, 0)) AS search_query_net_cost,
  SUM(a.list_cost) AS list_cost,
  SUM(a.net_cost) AS net_cost
FROM allocated AS a
LEFT JOIN usage AS u USING (day_jst, process, search)
GROUP BY a.day_jst, a.process, a.search
