-- One row per PostHog person: the latest version, deleted persons dropped.
-- The export writes a row per (person, distinct id) change.
SELECT
  person_id,
  created_at,
  JSON_VALUE(properties['$initial_utm_source']) AS first_utm_source,
  JSON_VALUE(properties['$initial_utm_campaign']) AS first_utm_campaign,
  properties
FROM (
  SELECT *
  FROM `{{project}}.posthog_raw.persons`
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY person_id
    ORDER BY person_version DESC, person_distinct_id_version DESC
  ) = 1
)
WHERE NOT IFNULL(is_deleted, FALSE)
