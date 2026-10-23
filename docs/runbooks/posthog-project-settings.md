# Runbook: PostHog project settings for product analytics

> **Background:** the OpenSpec change `expand-product-analytics` records page
> views, campaign values and masked session recordings in the fan app, and sends
> them to PostHog (EU project `190464`, "liverty-music-prod") through a managed
> reverse proxy on the app's own domain. The fan app's masking lives in the
> frontend repository (`src/lib/analytics/session-recording.ts`). The project
> settings are declared in this repository where the PostHog provider can hold
> them, and set by hand where it cannot; this runbook records both and how to
> check them. Error-tracking settings are in
> [frontend-error-tracking.md](frontend-error-tracking.md).

## What runs where

| Setting | Value | Managed by |
| --- | --- | --- |
| Project time zone | `Asia/Tokyo` (day boundaries of every insight) | this repository, prod stack (`src/posthog/components/product-analytics.ts`, `posthog.Project`) |
| Session recording | on | this repository (`src/posthog/components/error-tracking.ts`, `posthog.ProjectSettings` `sessionRecordingOptIn`; the project has one settings resource) |
| Managed reverse proxy | `https://beat.liverty-music.app` | this repository (`posthog.ProxyRecord` with [the organization key](#the-organization-key), and its Cloudflare CNAME, DNS-only) |
| Recording URL blocklist | the four patterns [below](#recording-url-blocklist) | by hand (no provider field) |
| Fan app `posthogApiHost` | the proxy host, once the proxy is valid | `k8s/namespaces/frontend/overlays/prod/fan-web-configmap.yaml` |

## The organization key

The proxy record belongs to the organization, not to a project (API
`/api/organizations/:organization_id/proxy_records/`), and a project-scoped key
cannot be given organization scopes ("Not available for project scoped keys").
The project's settings keep using the project-scoped management key
([frontend-error-tracking.md](frontend-error-tracking.md#the-management-key));
the proxy alone uses a second **personal API key** of the owner's account:

- **Projects:** not limited to a project (organization scopes require it).
- **Scopes:** **Organization: Write** only: no event, project or
  organization-member scope (Organization member is a separate scope).
- **Label:** `pulumi-posthog-proxy-<YYYYMMDD>`.
- **Stored in:** ESC `liverty-music/prod`, sent on stdin so the value never
  reaches shell history:
  `pulumi env set liverty-music/prod pulumiConfig.posthogOrganizationApiKey --file - --secret --string`.

Without it, the program manages no proxy and no CNAME; the project settings
are still applied.

## Rollout order

1. **Project import.** `posthog.Project` is imported with the project's current
   values (`timezone: UTC`): an import whose inputs differ from the live
   project fails. `pulumi up` from the Pulumi Cloud console.
2. **Time zone.** Change `timezone` to `Asia/Tokyo` in `product-analytics.ts`;
   the preview shows one in-place update of the protected project.
   `pulumi up`.
3. **Proxy.** The first `pulumi up` also creates the proxy record and its
   CNAME. Wait until PostHog reports the proxy as valid:
   [organization proxy settings](https://eu.posthog.com/project/190464/settings/organization-proxy),
   or `curl -sS https://beat.liverty-music.app` answers with PostHog's hog.
   The status can stay at "Issuing" in the UI although the proxy serves
   (PostHog issue #48399); the `curl` check decides.
4. **Fan app.** Only then set `posthogApiHost` to `https://beat.liverty-music.app`
   in the prod fan-web ConfigMap. Switching earlier drops every event until the
   certificate is issued.

## Recording URL blocklist

The fan app already blocks these screens' route elements, so a recording shows
an empty box there. The blocklist also pauses recording on their addresses, so
no recording is made while they are shown (OpenSpec `global/analytics`,
"Screen that is never recorded").

Set in [Replay settings](https://eu.posthog.com/project/190464/settings/environment-replay),
URL blocklist, each as a regex:

| Screen | Pattern |
| --- | --- |
| Checkout | `^https://liverty-music\.app/events/[^/]+/checkout` |
| Lottery entry and its status | `^https://liverty-music\.app/events/[^/]+/lottery/` |
| Identity check | `^https://liverty-music\.app/verify/` |
| Settings and passkeys | `^https://liverty-music\.app/settings` |

Check: the project's `session_recording_url_blocklist_config` lists the four
patterns (PostHog MCP `project-get`, or the settings page).

## Applied

| Date | What | By |
| --- | --- | --- |
| 2026-10-23 | Project import, proxy, recording on (`pulumi up`, prod update 277). The proxy served `/flags/`, `/array/…/config` and `/static/array.js` with 200 at once while PostHog still reported it as issuing | owner |
| | Time zone `Asia/Tokyo` (`pulumi up`) | |
| | Recording URL blocklist (by hand) | |
| | `posthogApiHost` switched to the proxy | |
