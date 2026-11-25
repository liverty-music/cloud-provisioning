# Runbook: an Organizer owner lost their passkey

> **When to use:** the owner of an Organizer (the person invited when the
> Organizer was provisioned) can no longer sign in to the organizer console
> because none of their passkeys works any more (device lost, passkey provider
> account lost). The product has no in-product recovery for this case yet; this
> runbook is the manual path an operator with `IAM_OWNER` on the Zitadel
> instance follows.

## Why the product cannot do it

- The owner's invitation can only be sent once. When provisioning runs again
  for an owner who already finished onboarding, Zitadel refuses the new
  invitation (`FailedPrecondition` or `AlreadyExists`), and the backend treats
  that as success and sends nothing
  (backend `internal/infrastructure/zitadel/organization_repository.go`, the
  `owner already onboarded; skipping re-invite` branch).
- The only emailed recovery in the product is for fans
  (`UserService.RequestPasskeyRecovery`, which issues a passkey registration
  link); it is not offered to an Organizer owner.
- The living spec requires an admin-initiated recovery path for Organizer
  owners (`components/infrastructure/organizer/web/global/hosted-login`,
  scenario "A recovery path exists for a lost passkey"). Until an admin console
  action exists (specification#1151), this runbook is that path.

## How it works

Zitadel keeps each passkey of a user as a separate entry. Recovery has two
parts, both done with the user service v2 API as an `IAM_OWNER`:

1. **Remove the lost passkey** so that whoever holds the lost device cannot
   sign in with it (`DELETE /v2/users/{user_id}/passkeys/{passkey_id}`).
2. **Send a passkey registration link** to the owner's verified email address
   (`POST /v2/users/{user_id}/passkeys/registration_link` with `sendLink`). The
   link opens the hosted login page `/ui/v2/login/passkey/set`, which registers
   a passkey with the code carried in the link and no sign-in. This is the same
   page and parameters the backend uses for fans
   (`internal/infrastructure/zitadel/passkey_registration_link.go`).

Both calls are checked against the owner's own organization, so `IAM_OWNER`
(the `pulumi-admin` machine user) may make them. Zitadel source at the running
version `v4.20.5`: `internal/command/user_human_webauthn.go`
(`removeHumanWebAuthN`) and `internal/command/user_v2_passkey.go`
(`addUserPasskeyCode`). References:

- <https://zitadel.com/docs/apis/resources/user_service_v2/user-service-list-passkeys>
- <https://zitadel.com/docs/apis/resources/user_service_v2/user-service-remove-passkey>
- <https://zitadel.com/docs/apis/resources/user_service_v2/user-service-create-passkey-registration-link>

The backend also emails the owner when a passkey is removed and when one is
added (`PASSKEY.removed`, `PASSKEY.added`); expect both emails during recovery.

> **Not exercised end to end.** Every call above is grounded in the Zitadel
> documentation or source and in the fan flow that runs in production, but this
> procedure has not been run against an Organizer owner. The first real use is
> its test: follow step 6 and note any difference in this file.

## Before you start: verify the person

The spec says recovery happens "after out-of-band verification". Do not send a
link because an email asked for it: whoever controls the owner's mailbox could
also be the person who took the lost device. Confirm that the request comes
from the owner through a channel that does not depend on that mailbox, for
example a call or a message thread with the owner that you started yourself.
What counts as enough verification is the product owner's decision; the
runbook only requires that one such check is done and recorded in the incident
note.

## Prerequisites

- `gcloud` with the `liverty-music` configuration and access to the secret
  `zitadel-machine-key-for-pulumi-admin` in `liverty-music-prod`.
- The owner's email address as registered for the Organizer.

## Procedure

Set the variables once (the email and IDs are not stored in this repository):

```bash
export ZITADEL=https://auth.liverty-music.app
OWNER_EMAIL='<the owner email>'
```

### 1. Get an `IAM_OWNER` access token

Follow steps 1 and 2 of [`zitadel-break-glass.md`](zitadel-break-glass.md), but
for prod: that runbook is written for dev, so edit two values in what you copy.
Use `--project=liverty-music-prod` in the `gcloud secrets` command, and change
the `ZITADEL = "https://auth.dev.liverty-music.app"` constant in the Python
script to `https://auth.liverty-music.app` (it is the JWT audience and the token
endpoint; the shell variable `ZITADEL` below does not reach it). Before the
sanity call at the end of the script, add two lines that keep the
token in a file readable only by you, so it never appears in a command line:

```python
import os
fd = os.open("/tmp/zitadel-token.hdr", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, f"Authorization: Bearer {token}".encode()); os.close(fd)
```

Every `curl` below passes it with `-H @/tmp/zitadel-token.hdr`. Delete
`/tmp/zitadel-token.hdr` and the machine key file when you are done.

### 2. Find the owner's user and organization

```bash
curl -sS -X POST "$ZITADEL/v2/users" -H @/tmp/zitadel-token.hdr \
  -H 'Content-Type: application/json' \
  -d "{\"queries\":[{\"emailQuery\":{\"emailAddress\":\"$OWNER_EMAIL\"}}]}" \
  | jq '.result[] | {userId, username, preferredLoginName, orgId: .details.resourceOwner}'
```

(`POST /v2/users` with `emailQuery`; the query messages are in Zitadel's
`user/v2/query.proto`.) The email can belong to several identities: a fan
account and the owner identities of several Organizations. The owner identity's
`username` is the email followed by the Organizer's short name in parentheses
(`ownerUserName` in the backend). Pick the entry whose `username` carries the
short name of the Organizer in question and note its `userId` and `orgId`:

```bash
USER_ID=<userId>
ORG_ID=<orgId>
```

### 3. List and remove the lost passkey

```bash
curl -sS -X POST "$ZITADEL/v2/users/$USER_ID/passkeys/_search" \
  -H @/tmp/zitadel-token.hdr -H 'Content-Type: application/json' -d '{}' \
  | jq '.result[] | {id, name, state}'
```

Ask the owner which passkey is lost by its `name` (their authenticator or
device name). If they cannot tell, or lost them all, remove every entry. Remove
each lost one:

```bash
curl -sS -X DELETE "$ZITADEL/v2/users/$USER_ID/passkeys/<passkey id>" \
  -H @/tmp/zitadel-token.hdr
```

Success is a `200` with a `details` object. A `404` means the passkey is
already gone.

### 4. Send the registration link

```bash
curl -sS -X POST "$ZITADEL/v2/users/$USER_ID/passkeys/registration_link" \
  -H @/tmp/zitadel-token.hdr -H 'Content-Type: application/json' \
  -d "{\"sendLink\":{\"urlTemplate\":\"$ZITADEL/ui/v2/login/passkey/set?userId={{.UserID}}&code={{.Code}}&codeId={{.CodeID}}&organization={{.OrgID}}\"}}"
```

Zitadel emails the link to the owner's verified address. The template uses the
placeholders `{{.UserID}}`, `{{.OrgID}}`, `{{.CodeID}}` and `{{.Code}}` from the
API reference. The link expires (the fan spec states 1 hour for the same kind of
link); if it does, repeat this step.

If the email does not arrive, see [`zitadel-smtp-drift.md`](zitadel-smtp-drift.md).
As a fallback that avoids email, request the code with
`{"returnCode":{}}` instead (the form the backend uses for fans), build
`$ZITADEL/ui/v2/login/passkey/set?userId=$USER_ID&code=<code.code>&codeId=<code.id>&organization=$ORG_ID`
yourself, and hand it to the verified owner. Treat that link like a password.

### 5. The owner registers a new passkey

The owner opens the link in the browser on a device that can create a passkey,
confirms the passkey prompt, and signs in to the organizer console with it.

### 6. Check and clean up

- `POST /v2/users/$USER_ID/passkeys/_search` (step 3) lists the new passkey.
- The owner can sign in to the organizer console.
- Delete `/tmp/zitadel-token.hdr` and the machine key file.
- Record in the incident note: who was verified and how, the date, and the
  `userId` (not the email).

## What is missing in the product

- No admin console action does this (specification#1151). The spec's recovery
  requirement is therefore met only by this manual procedure, and its scenario
  stays `@spec-manual`.
- The spec says recovery is a "re-invite". The runbook uses a passkey
  registration link, because the invitation of an onboarded owner is refused
  (see "Why the product cannot do it"). The spec wording should follow.
- The spec's second clause (a policy with no recovery path is rejected) has no
  implementation.
