# Runbook: add a new Zitadel admin user (Google SSO, IAM_OWNER)

> **Background:** OpenSpec change `add-zitadel-console-admin-via-google-idp`
> set up the `admin` role org with `LoginPolicy.userLogin = false` and
> `IdpGoogle.isCreationAllowed = false`. That combination intentionally
> blocks any "sign in once and Zitadel will figure it out" path, so a
> new admin's Google identity has to be **pre-linked** to a
> Pulumi-declared local user via `ZitadelUserIdpLink` before they can
> sign in. This runbook walks the full operation.

## When to use this runbook

Use this whenever a new human operator needs `IAM_OWNER` on the
self-hosted Zitadel instance (e.g. they need to access
`https://auth.dev.liverty-music.app/ui/console`). Anyone with
`IAM_OWNER` can manage every org in the instance, so apply the same
gating you would for a GCP project Owner — assume each grant is
high-trust.

This runbook is **not** for end users (people signing into the
product). End-user sign-up flows live in the `liverty-music` product
org and use the standard register-via-passkey path; nothing in this
file applies to them.

## Prerequisites

The new admin must:

- Have a Google account on a domain wired into the Zitadel admin org's
  IdP (today: `pannpers.dev` Workspace).
- Have working `gcloud` access OR be able to use the
  [OAuth Playground](https://developers.google.com/oauthplayground/)
  in a browser (for the sub-claim lookup in step 1).

You (the operator running this runbook) must have:

- Push access to `liverty-music/cloud-provisioning`.
- `esc` CLI authenticated against the `liverty-music` org.
- `gh` CLI authenticated for opening the PR.

## Step 1 — get the new admin's Google `sub` claim

Zitadel keys IdP links by the external user's stable subject identifier
(`sub`), not their email. We need that 21-digit number before any
Pulumi code can declare the link.

The new admin runs **one** of these (whichever is easier for them):

### Option A — OAuth Playground (browser only, ~3 min)

1. Open <https://developers.google.com/oauthplayground/>.
2. In the left "Step 1" panel, scroll to **Google OAuth2 API v2** and
   tick `https://www.googleapis.com/auth/userinfo.profile`.
3. Click **Authorize APIs**, sign in as the new admin's Google
   account, accept the consent screen.
4. **Exchange authorization code for tokens** (Step 2 panel).
5. In Step 3 (right panel), call
   `GET https://www.googleapis.com/oauth2/v2/userinfo`.
6. The response JSON's `id` field is the `sub`. Copy it.

### Option B — `gcloud` + userinfo (CLI, ~1 min)

```bash
# Make sure gcloud is signed in as the new admin's account.
gcloud config get-value account
# If wrong: gcloud auth login <new-admin-email>

TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.googleapis.com/oauth2/v2/userinfo
```

Look for `"id": "117…"` in the response. That's the `sub`.

> `gcloud auth print-identity-token --audiences=...` is the more
> obvious path but rejects user accounts ("Invalid account type for
> `--audiences`. Requires valid service account."). Don't bother with
> it.

The `sub` is **not** secret on its own — it's just an opaque ID Google
issues per account — but treat it as low-sensitivity config (we still
store it under ESC `--secret` to keep the Pulumi config surface
uniform).

## Step 2 — store the `sub` in ESC

```bash
esc env set liverty-music/dev pulumiConfig.zitadel.adminGoogleSubs.<userName> <sub> --secret
```

Where:

- `<userName>` is the Pulumi-side identifier you'll use in code
  (kebab-case, e.g. `pannpers`, `alice`). Keep it short and stable —
  changing it later forces a Pulumi resource rename.
- `<sub>` is the value from step 1.

Verify:

```bash
esc env get liverty-music/dev pulumiConfig.zitadel.adminGoogleSubs.<userName>
# Expect: "[secret]" with a Definition ciphertext line
```

> Repeat for `liverty-music/staging` and `liverty-music/prod` as those
> environments adopt the self-hosted topology. Today only `dev` has
> the Zitadel stack; staging / prod sets are tracked by the OpenSpec
> change `add-zitadel-console-admin-via-google-idp` D10.

## Step 3 — declare the admin in Pulumi

In `src/zitadel/index.ts`, the `Zitadel` class today instantiates a
single `HumanAdminComponent` for `pannpers`. Two extension paths:

### 3a — Adding the second / third admin (small fan-out)

Duplicate the existing block, plumbing in a new `pannpersGoogleSub`-
style ESC field via `ZitadelArgs`:

```ts
this.aliceAdmin = new HumanAdminComponent(`${name}-alice`, {
  adminOrgId: this.adminOrg.id,
  email: 'alice@pannpers.dev',
  firstName: 'Alice',
  lastName: 'Example',
  googleIdpId: this.googleAdminIdp.idp.id,
  googleSub: aliceGoogleSub,        // new ZitadelArgs field
  domain,
  jwtProfileJson,
  provider: this.provider,
})
```

And in `src/index.ts` extend the typed ESC schema:

```ts
const zitadelConfig = config.requireSecretObject<{
  googleAdminIdp: { clientId: string; clientSecret: string }
  adminGoogleSubs: { pannpers: string; alice: string }   // ← add new key
}>('zitadel')
```

Then thread the new key through `ZitadelArgs` the same way
`pannpersGoogleSub` is plumbed today.

### 3b — Beyond ~5 admins (refactor recommended)

Refactor `HumanAdminComponent` to accept a `HumanAdminSpec[]` array
and iterate. The current per-admin component is fine for the small
fan-out we have today; refactor the moment a third admin lands so
the duplication doesn't ossify.

## Step 4 — run pre-commit checks locally

```bash
make check
```

This runs `biome check`, `tsc --noEmit`, and the vitest suite. Fix
anything red before pushing.

## Step 5 — open the PR and let the auto-deploy take over

```bash
git checkout -b add-admin-<userName>
git add -A
git commit -m "feat(zitadel): add <userName>@pannpers.dev as admin"
git push -u origin HEAD
gh pr create --assignee pannpers --reviewer pannpers
```

Merging to `main` triggers Pulumi Cloud Deployments to run
`pulumi up` against `dev` automatically. Watch:

- <https://app.pulumi.com/pannpers/liverty-music/dev/deployments>
- `gh run list --repo liverty-music/cloud-provisioning --branch main --limit 3`

The new resources you should see in the diff:

- `zitadel.HumanUser` (the local user)
- `zitadel.InstanceMember` (`IAM_OWNER`)
- `ZitadelUserIdpLink` (the pre-link)

## Step 6 — verify Console sign-in end-to-end

In a private window (so old sessions don't mask cookie/policy issues):

1. Open <https://auth.dev.liverty-music.app/ui/console>.
2. Click **Google (admin)**.
3. Sign in with the new admin's Google account.
4. **Expected:** Console loads with full instance access. The new
   admin should be able to read every org in the instance.

If the sign-in dead-ends on `/ui/v2/login/idp/google/account-not-found`,
the link did not register correctly. Most common causes:

- ESC `sub` value typo (extra whitespace, wrong digits) — re-run
  step 1, compare byte-for-byte.
- The Google account used for sign-in differs from the one whose
  `sub` you captured (e.g. they signed in to OAuth Playground as a
  personal account but to Console as the Workspace account). Both
  must be the same Google identity.
- Stale Login V2 in-memory policy cache:
  `kubectl -n zitadel rollout restart deployment/zitadel-login`.
- IdP intent landed but the user's `IAM_OWNER` membership missing —
  check via the Zitadel admin API:
  ```bash
  curl -s -H "Authorization: Bearer $(./tmp/get-zitadel-jwt.sh)" \
    "https://auth.dev.liverty-music.app/admin/v1/members/_search" \
    | jq '.result[] | select(.userId=="<userId>")'
  ```

## Removing an admin

Follow the inverse:

1. Delete the `HumanAdminComponent` block from `src/zitadel/index.ts`.
2. Remove the `adminGoogleSubs.<userName>` ESC entry:
   ```bash
   esc env rm liverty-music/dev pulumiConfig.zitadel.adminGoogleSubs.<userName>
   ```
3. PR + merge. Pulumi will:
   - DELETE the IdP link via `/v2/users/{userId}/links/{idpId}/{externalUserId}`
   - Remove the `IAM_OWNER` instance membership
   - Delete the local `HumanUser`

The user's Workspace Google account is unaffected (we only manage
Zitadel-side state).

## Reference

- OpenSpec change: `add-zitadel-console-admin-via-google-idp`
- Component: [`src/zitadel/components/human-admin.ts`](../../src/zitadel/components/human-admin.ts)
- Dynamic resource: [`src/zitadel/dynamic/user-idp-link.ts`](../../src/zitadel/dynamic/user-idp-link.ts)
- Initial implementation PR: liverty-music/cloud-provisioning#229
