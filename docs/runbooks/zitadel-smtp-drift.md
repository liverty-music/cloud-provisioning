# Runbook: Zitadel SMTP configuration drift

> **Background:** this runbook covers the SMTP drift problem introduced
> alongside the `fix-prod-zitadel-instance-config` OpenSpec change. The
> Zitadel `SmtpConfig` resource is managed by Pulumi, but Zitadel can
> internally transition the SMTP config from `SMTP_CONFIG_ACTIVE` to an
> inactive state (e.g. after a pod restart). Pulumi's recorded state does
> not reflect this in-process drift, so a plain `pulumi up` sees no change
> and does nothing. A targeted `--refresh` is needed to detect and heal it.

## Symptom

Email notifications from Zitadel (passkey invitations, login emails, etc.)
are not delivered. The Postmark prod server (`Liverty Music [prod]`) shows
no recent outbound activity.

This is **not** a Postmark configuration problem — the SMTP credentials
and domain are verified. The issue is that Zitadel's internal SMTP config
has drifted to inactive.

## Root cause

Zitadel SMTP activation is a runtime state separate from the SMTP config
record. Pulumi manages an `smtp-activation` dynamic resource
(`src/zitadel/dynamic/smtp-activation.ts`) that calls `POST
/admin/v1/smtp/<id>/_activate` to set it active. The `read` function
detects drift by calling `POST /admin/v1/smtp/_search` and comparing the
returned `state` to `SMTP_CONFIG_ACTIVE`.

Pulumi only calls `read` during `pulumi refresh` or `pulumi up --refresh`.
A plain `pulumi up` uses the recorded state (which shows "active") and
skips the check. Therefore SMTP stays inactive until a refresh is forced.

**Full `pulumi up --refresh` is not safe for prod** because the
`gcp:billing/budget` resource is flaky on refresh and aborts the entire
update. Use the targeted form below.

## Remediation

**Targeted refresh + reactivation (safe for prod):**

```bash
# From the cloud-provisioning repo, prod stack:
pulumi stack select prod

pulumi up --refresh \
  --target 'urn:pulumi:prod::liverty-music::zitadel:liverty-music:Smtp$pulumi-nodejs:dynamic:Resource::smtp-activation' \
  --target-dependents
```

This scopes the refresh to only the `smtp-activation` resource and its
dependents, avoiding the flaky billing budget resource.

Expected output: `smtp-activation` shows `update` (the drift-detecting
`read` returns empty `id` → Pulumi replaces → `_activate` is called →
`SMTP_CONFIG_ACTIVE`).

**Alternatively, trigger from the Pulumi Cloud console:**

1. Navigate to: https://app.pulumi.com/pannpers/liverty-music/prod
2. Click **Actions → Update**
3. Under **Advanced**, enter the target URN above in the "Target resources" field
4. Enable "Refresh before update"
5. Click **Update**

## Verification

After remediation, trigger a Zitadel email and confirm delivery:

1. In the Zitadel admin console (`https://auth.liverty-music.app/ui/console`),
   navigate to a user → **Send password reset email** (or re-invite an
   operator via `organizer-accounts`).
2. Check the Postmark prod server Activity tab for a "Sent" message to
   that address.

Alternatively, call the Zitadel SMTP test endpoint (requires admin PAT):

```bash
curl -s -X POST \
  "https://auth.liverty-music.app/admin/v1/smtp/<config-id>/_test" \
  -H "Authorization: Bearer <admin-PAT>" \
  -H "Content-Type: application/json" \
  -d '{"receiverAddress":"your-email@example.com"}'
# Expect: {} (empty 200) and a test email in your inbox
```

## Preventing recurrence

The `smtp-activation` Pulumi resource's `read` function is drift-detecting
(added in `fix-prod-zitadel-instance-config`). Running `pulumi up` with
a targeted refresh on any Pulumi Cloud console update to the prod stack
will auto-heal SMTP drift as a side-effect. No separate automation is
required as long as targeted refresh is included in prod deploy runs that
touch the Zitadel component.

Until a routine refresh cadence is established, treat SMTP silent failure
as an indicator that a targeted refresh is due.

## Related

- `src/zitadel/dynamic/smtp-activation.ts` — the drift-detecting dynamic resource.
- `specification/openspec/changes/fix-prod-zitadel-instance-config/` — OpenSpec change.
- Postmark prod server: `Liverty Music [prod]` (distinct from dev `Liverty Music [dev]`).
