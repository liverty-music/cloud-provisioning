# Runbook: frontend error tracking (PostHog)

> **Background:** the OpenSpec change `capture-client-errors` sends every error
> the fan app captures to PostHog Error Tracking (EU project `190464`,
> "liverty-music-prod"), with source maps uploaded by the frontend image build.
> The code lives in the frontend repository. The PostHog settings are declared
> in this repository where the PostHog provider can hold them (alerts, exception
> autocapture) and set by hand where it cannot (billing limit, rate limits);
> this runbook records both and how to check them.

## What runs where

| Piece | Where | Managed by |
| --- | --- | --- |
| Error reports (`$exception`) | Fan app → `eu.i.posthog.com` | frontend code (`AnalyticsService.captureException`) |
| Source-map upload | frontend `push-image.yaml`, main-push build of the fan image | `@posthog/rollup-plugin` in `vite.config.ts` |
| Upload key | GitHub repo-level Actions secret `POSTHOG_SOURCEMAP_API_KEY` on `liverty-music/frontend` | this repository, prod stack (`src/index.ts`, `posthogSourcemapApiKey`) |
| Alerts to Slack, exception autocapture off | PostHog project `190464` | this repository, prod stack (`src/posthog/components/error-tracking.ts`, bridged Terraform provider `PostHog/posthog`) |
| Management key | ESC `liverty-music/prod` `pulumiConfig.posthogManagementApiKey` | the owner, [below](#the-management-key) |
| Billing limit, rate limits | PostHog organization billing and project `190464` | by hand, this runbook (no provider resource) |
| Alert channel | Slack `#alert-frontend-prod` (`C0CBL2URPA6`), PostHog Slack integration id `83774` | the owner (Slack admin) |

## The upload key

### Scope

A **personal API key** of the owner's PostHog account:

- **Project:** `190464` only (not "all projects").
- **Scopes:** the **Source map upload** preset of the key dialog:
  `error_tracking:write` and `organization:read`. posthog-cli's README lists
  only `error_tracking:write` for `sourcemap`, but PostHog's upload guides and
  the preset both include `organization:read`; follow the preset.
- **Label:** `frontend-sourcemap-upload-<YYYYMMDD>`.

With those scopes the key cannot read events or change settings; a leak lets an
attacker upload symbol sets to the project and read the organization's
metadata (name, members, projects).

Scopes the key was issued with (2026-10-23): the **Source map upload** preset,
which grants `error_tracking:write` and `organization:read` and nothing else.

### Why a personal key (workaround)

A CI credential should not belong to a person. PostHog's **project secret API
keys** are made for this (project-scoped, not tied to a user, only the scopes
granted), but as of October 2026 they support only `feature_flag:read`,
`endpoint:read` and `support_ticket:read`. Every PostHog source-map guide
requires a personal API key, and PostHog documents no OIDC login for the CLI.
So the key depends on its owner's account: if that account is removed, the key
is deleted and main-push builds fail at the upload.

**Exit condition:** when
[project secret API keys](https://posthog.com/docs/api/project-secret-api-keys)
accept `error_tracking:write` for source-map upload, create one with that scope,
store it in place of this key (same ESC path, same steps), and delete the
personal key. Check the scope list at each 6-monthly rotation.

### Issue and store

1. In PostHog EU, **Account → Personal API keys → Create personal API key**:
   **Organization & project access** limited to project `190464`, expiration
   **Never** (rotation below replaces it), scopes from the **Source map upload**
   preset. Copy the value; PostHog does not show it again.
2. Store it in ESC through stdin, so it never appears in shell history or a
   process list. `tr` drops the line break that pressing Enter after the paste
   adds: a key stored with it breaks every request (`invalid header field value
   for "Authorization"`).

   ```sh
   tr -d '\r\n' | pulumi env set liverty-music/prod \
     pulumiConfig.posthogSourcemapApiKey --file - --secret --string
   # paste the key, press Enter, then Ctrl-D
   ```

3. Check that the key is listed without printing it:

   ```sh
   pulumi env get liverty-music/prod pulumiConfig.posthogSourcemapApiKey
   ```

   The output shows `[secret]`, not the value.
4. Run `pulumi up` on the prod stack. The preview shows one new
   `github:index/actionsSecret:ActionsSecret` for `POSTHOG_SOURCEMAP_API_KEY`.
5. Check: `gh secret list --repo liverty-music/frontend` lists
   `POSTHOG_SOURCEMAP_API_KEY`.

### Rotate

Rotate every 6 months (with the other PostHog keys,
[posthog-secret-rotation.md](./posthog-secret-rotation.md)), when the key may
have leaked, or when its owner leaves.

1. Issue a new key as above; leave the old one active.
2. Store it in ESC (step 2 above) and run the prod `pulumi up`.
3. Re-run the latest `Deploy Frontend` run on `main` (or merge the next
   change) and check its log for a successful source-map upload.
4. Delete the old key in PostHog.

## The management key

The PostHog provider in the prod stack authenticates with its own key. It is not
the upload key: that one sits in GitHub Actions, and a key a CI build can read
must not be able to change alerts.

- **Kind:** personal API key of the owner's PostHog account, for the same reason
  as the upload key (project secret API keys accept neither scope below yet).
  The exit condition above applies to this key too.
- **Project:** `190464` only.
- **Scopes:** **Hog functions: Write** (`hog_function:write`, for the alerts)
  and **Project: Write** (`project:write`, for the project settings), nothing
  else.
- **Label:** `pulumi-posthog-management-<YYYYMMDD>`.

Issue it like the upload key, then store it:

```sh
tr -d '\r\n' | pulumi env set liverty-music/prod \
  pulumiConfig.posthogManagementApiKey --file - --secret --string
# paste the key, press Enter, then Ctrl-D
```

Until the value is set, the prod stack manages no PostHog resource
(`src/index.ts`). Rotate it on the same schedule: issue a new key, store it,
run the prod `pulumi up` (the preview shows only the provider's `apiKey`
changing), then delete the old key.

## Volume limits

With no users yet, a runaway loop is the only way to reach these limits. They
are the backstop behind the SDK's own limiter (burst 10, refill 1 per second)
and the banner's 60-second repeat rule.

### Billing limit: 0 USD

**Organization → Billing → Error tracking → Set billing limit**, `0`. Ingestion
then stops at the free 100,000 exceptions a month instead of charging. The
organization owner receives emails at 80 % and 100 % of the free allotment.

Check: the billing page shows the limit under Error tracking, or the PostHog
MCP `billing-overview-get` returns `custom_limits_usd.error_tracking: 0` and
error tracking's `usage_limit: 100000`. Set on 2026-10-23; confirmed with the
MCP the same day.

### Rate limits

**Error Tracking → Configuration → Rate limits.** Both are token buckets; an
exception over the limit is dropped before ingestion and not billed.

- **Project-wide: 100 exceptions per hour.** Even at the limit all month,
  that is at most about 72,000 exceptions, under the free 100,000, so this
  limit stops a runaway before the billing limit does.
- **Per issue: 20 exceptions per hour.** It must be well below the
  project-wide limit: at the same value, one looping issue would use the whole
  project budget and drop every other issue's exceptions. Twenty occurrences
  carry the stack, steps and trace ID needed to investigate.

Record what was set:

| Limit | Value | Set on | By |
| --- | --- | --- | --- |
| Project-wide | 100 per 1 hour | 2026-10-23 | owner (UI) |
| Per issue | 20 per 1 hour | 2026-10-23 | owner (UI) |

## Alerts to `#alert-frontend-prod`

Two alerts: one when a new issue appears, one when a resolved issue comes back.
Spiking is not alerted: with no users, any recurrence is already a new or
reopened issue.

### Prerequisite (owner, Slack admin)

1. Create the channel `#alert-frontend-prod`.
2. Invite the PostHog app to it (`/invite @PostHog`). The alerts post to the
   channel by id, `C0CBL2URPA6`; a renamed channel keeps working, a new channel
   needs its id changed in `src/posthog/components/error-tracking.ts`.

### Declared in code

`src/posthog/components/error-tracking.ts` declares both alerts as
`posthog.HogFunction` resources (`type: internal_destination`,
`template_id: template-slack`), with the message layout PostHog's own alert
wizard uses:

- `Issue created · #alert-frontend-prod`, event `$error_tracking_issue_created`;
- `Issue reopened · #alert-frontend-prod`, event
  `$error_tracking_issue_reopened`.

Change them there, not in the PostHog UI: the next prod `pulumi up` reverts a
UI edit. An alert made in the UI is not managed; bring it under the stack with
`pulumi import posthog:index/hogFunction:HogFunction <name> 190464/<uuid>` or
delete it.

### Check

- The PostHog MCP `error-tracking-alerts-list`
  (`type: ["internal_destination"]`) shows both, enabled.
- Throw an error from the browser console on liverty-music.app with analytics
  on (`setTimeout(() => { throw new Error('alert check') })`), and check that a
  post arrives in `#alert-frontend-prod`. Resolve the issue afterwards.

## Building without source maps while PostHog is down

The upload runs inside the image build, and a failed upload fails the build on
purpose: a missing map only shows up later, as unreadable stacks. If PostHog is
down for longer than a re-run can wait and a fix must ship:

1. Delete the repo secret: `gh secret delete POSTHOG_SOURCEMAP_API_KEY --repo
   liverty-music/frontend`. The build then skips the upload and is otherwise
   unchanged.
2. Ship the fix. Errors from that image show minified stacks.
3. When PostHog is back, restore the secret with the prod `pulumi up` (the ESC
   value is unchanged), and let the next main push upload maps again.

## Adding a suppression rule

When an issue is noise that no code change can fix (a third-party "Script
error." with no frames, a browser bug), drop it at ingestion instead of letting
it alert:

1. Open the issue and confirm it is not ours: no frame from
   `liverty-music.app`, or a known browser/extension message.
2. **Error Tracking → Configuration → Suppression rules → Add rule**, scoped as
   tightly as possible (exception type **and** message, not message alone).
3. Record the rule and the issue link below.

Suppressed errors are dropped permanently, including any later occurrence that
is ours. Prefer resolving an issue over suppressing it when unsure.

| Rule | Issue | Added on | Why |
| --- | --- | --- | --- |
| _none yet_ | | | |
