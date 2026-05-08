# Runbook: Recreate the Zitadel admin Google OAuth client

> **When to use:** the Google OAuth 2.0 Web Application client behind
> Zitadel's admin Google IdP has been deleted, disabled, or its
> redirect URI mangled — and as a result `https://auth.dev.liverty-music.app/ui/console`
> Google sign-in returns `redirect_uri_mismatch`, `unauthorized_client`,
> or `disabled_client`. This runbook walks the manual recreation path.

## Why this is manual (not Pulumi)

Google does **not** expose a public API for creating general-purpose
OAuth 2.0 Web Application clients. The only declarative-tool option
in `@pulumi/gcp` is `gcp.iap.Client`, which (a) was deprecated
2025-01-22 and shut down 2026-03-19, and (b) is scoped to
Identity-Aware Proxy, not generic OIDC sign-in. So the OAuth client
is created **once per environment** through the Google Cloud Console
UI; from then on, all rotation happens via `esc env set` + `pulumi up`.

See OpenSpec change `add-zitadel-console-admin-via-google-idp` design
D6 for the full rationale.

## Pre-conditions

- You have **Owner** or **OAuth Config Admin** on the `liverty-music-dev`
  GCP project.
- You can sign in to Google as a member of the `pannpers.dev`
  Workspace (the Internal consent screen audience).
- You have `esc` CLI authenticated against `liverty-music`
  (`esc env ls` lists the org's environments).

## Step 1 — re-establish the consent screen if it was reset

The OAuth client is gated by the project's "Auth Platform" (Google's
new combined OAuth-consent + client UI replacing the old separate
"OAuth consent screen" + "Credentials" pages). If only the client
was deleted, the consent screen survives — skip this step.

If the consent screen is also gone:

1. Open <https://console.cloud.google.com/auth/overview?project=liverty-music-dev>.
2. Choose **User type: Internal** (limited to `pannpers.dev`
   Workspace — no Google review or external verification).
3. **App name:** `Liverty Music Admin Console (dev)`.
4. **Support email:** `pannpers@pannpers.dev`.
5. **Developer contact email:** `pannpers@pannpers.dev`.
6. **Authorised domain:** add `liverty-music.app` (so that the
   Zitadel callback URL `auth.dev.liverty-music.app` is accepted at
   client-creation time).
7. **App logo / homepage:** leave empty for dev. Save.

## Step 2 — create the Web Application client

1. Open <https://console.cloud.google.com/auth/clients?project=liverty-music-dev>
   → **Create Client**.
2. **Application type:** `Web application`.
3. **Name:** `Zitadel Admin IdP (dev)`.
4. **Authorised JavaScript origins:** *(none — leave empty)*.
5. **Authorised redirect URIs:** add exactly this single entry:
   ```
   https://auth.dev.liverty-music.app/idps/callback
   ```
   This is the Zitadel v4 Login V2 fixed callback path. No IdP id
   suffix — Zitadel uses the same path for every external IdP and
   resolves which one by the `state` parameter. See OpenSpec
   pre-flight task 1.4.
6. **Create.** Copy the `Client ID` and `Client secret` from the
   modal that appears (the secret is only shown once).

## Step 3 — push the new credentials to Pulumi ESC

```bash
# Replace the placeholders with the values from Step 2.
esc env set liverty-music/dev pulumiConfig.zitadel.googleAdminIdp.clientId \
  '<NEW_CLIENT_ID>.apps.googleusercontent.com'
esc env set liverty-music/dev pulumiConfig.zitadel.googleAdminIdp.clientSecret \
  '<NEW_CLIENT_SECRET>' --secret
```

> **Important:** the existing OpenSpec change wrote `clientId` as
> plaintext (no `--secret`) and `clientSecret` as encrypted
> (`--secret`). Match that pattern — `clientId` is not sensitive and
> being able to read it back from `esc env get` without the project's
> decrypt key simplifies debugging.

Verify (use `--value string` so `esc` prints just the value, not the
markdown envelope it would otherwise render — matches the established
pattern in [`docs/TICKET_SYSTEM_SETUP.md`](../TICKET_SYSTEM_SETUP.md)):

```bash
esc env get liverty-music/dev --value string pulumiConfig.zitadel.googleAdminIdp.clientId
# expected: a printable client_id

esc env get liverty-music/dev --value string pulumiConfig.zitadel.googleAdminIdp.clientSecret
# expected: "[secret]" (value is masked; add --show-secrets to reveal)
```

## Step 4 — let Pulumi reconcile

Merging any change to `cloud-provisioning/main` triggers Pulumi Cloud
Deployments to run `pulumi up` against `dev`. If you don't have a
pending change, push an empty-diff commit (e.g. a comment-only edit
to a docs file) to wake the auto-deploy. **Do NOT** run `pulumi up`
locally against the `dev` stack — per the project CLAUDE.md, local
`pulumi up` conflicts with the automated job and is expressly
forbidden in this repo.

The `IdpGoogle` Pulumi resource will detect the changed `clientId` /
`clientSecret` and submit an update to Zitadel without recreating
the IdP. Existing `ZitadelUserIdpLink` records survive — the
`(idpId, externalUserId)` tuple does not change.

## Step 5 — smoke test the admin sign-in flow

1. Open `https://auth.dev.liverty-music.app/ui/console` in a private
   window (so old session cookies don't mask the broken state).
2. Click **Google (admin)**.
3. Sign in as `pannpers@pannpers.dev` (or any other admin pre-linked
   per [`add-zitadel-admin-user.md`](add-zitadel-admin-user.md)).
4. **Expected:** Console loads with `IAM_OWNER` privileges. No
   `redirect_uri_mismatch` from Google, no `account-not-found` from
   Zitadel.

If sign-in still fails:

- `redirect_uri_mismatch` from Google → the redirect URI in Step 2.5
  is wrong. Confirm exact match (no trailing slash, http vs https,
  hostname spelling).
- `unauthorized_client` from Google → the Web Application client is
  paused or in the wrong project. Confirm it's in
  `liverty-music-dev` and Active.
- `account-not-found` from Zitadel → the OAuth client is fine but
  the IdP-link record for the human admin is missing. Follow
  [`add-zitadel-admin-user.md`](add-zitadel-admin-user.md) Step 6
  troubleshooting.

## Why we don't rotate the secret on a fixed schedule

The Google OAuth client secret has no expiry. Rotation here is
event-driven — you rotate when there is reason to believe the secret
is compromised (laptop loss, leaked CI logs, etc.), not on a calendar.
The rotation procedure is the same as Step 3 above (write the new
secret to ESC, let Pulumi reconcile). Existing admin sessions remain
valid until they expire naturally; new sign-in attempts use the new
secret.

## Reference

- OpenSpec change: `add-zitadel-console-admin-via-google-idp`
- Spec requirement: *"Maintain Google OAuth Client in Dev Infrastructure"*
- Design decision: D6
- Admin user lifecycle: [`add-zitadel-admin-user.md`](add-zitadel-admin-user.md)
- Total lockout recovery: [`zitadel-break-glass.md`](zitadel-break-glass.md)
