# Runbook: Pulumi state recovery after a `state delete` cascade

> **Source of truth:** this runbook is derived from `specification`
> spec `pulumi-state-recovery` (worked example transcribed from the
> archived `self-hosted-zitadel` change, §13.4). If the spec is
> updated, regenerate this file in the same PR.

> **When to use:** the Pulumi `dev` (or any other) stack lost
> resources it should still own — usually after an operator-side
> `pulumi state delete --target-dependents` invocation cascade-removed
> more than the intended scope. `pulumi preview` now shows a large
> bank of "creates" for resources that physically still exist in GCP
> (or other clouds), so applying would either fail mid-way or
> double-create live infrastructure.
>
> This runbook covers **state-side recovery only** — reconciling the
> Pulumi state file with the (still-correct) cloud-side reality. It
> does **not** cover recovery from genuine cloud-side resource loss;
> for that the answer is `pulumi up` against a clean state, not
> anything in this document.

## STOP — try this first

If you are reading this *before* invoking `pulumi state delete`, you
are still in the prevention window. Don't read past this section —
use one of the safer paths below instead.

| You want to … | Use … | Why |
|---|---|---|
| Remove a resource that should genuinely be destroyed in the cloud | `pulumi destroy --target <urn>` | Goes through the normal `preview → up` flow, visible to PR reviewers via Pulumi Cloud's `previewPullRequests=true`, stays inside Pulumi's safety model. |
| Remove a resource from code (you deleted/renamed the TS) | normal `pulumi up` on the PR | Pulumi computes the destroy diff; reviewer sees it in the preview comment. |
| Re-import an orphaned resource (provider panicked, state half-written) | `pulumi state delete <urn>` *without* `--target-dependents`, then `pulumi import` | Single-resource surgery. No transitive blast radius. |

**`pulumi state delete --target-dependents` is reserved for the very
narrow case where**: a resource is stuck in state but the cloud-side
object no longer exists, AND every transitive child of that resource
also needs to be re-imported. In practice that is almost never the
right answer — `--target` on a normal `destroy` covers the
declarative path; raw state surgery covers the surgical path. The
cascade flag sits in an awkward middle that this runbook exists
because of.

If you've already invoked `--target-dependents` and got more deletes
than you bargained for, continue to **Why this cascades**.

## Why this cascades — the blast-radius footgun

`pulumi state delete --target-dependents` follows the **full
dependency graph**, not just the subtree of the resource's
ComponentResource. That is: it removes the target, *plus every
resource that has any dependency edge into the target's transitive
closure*.

In the dev stack, the Cloud-tenant Zitadel `Project` /
`ApplicationOidc` / `LoginPolicy` / etc. resources depended on:

- the `liverty-music-provider` (which depended on the GSM secret,
  which depended on the GCP `Project`, which depended on the Folder),
- the GKE `Cluster` (because some of the Zitadel resources were
  parented under Kubernetes overlays during the cutover spike),
- the Cloud SQL instance (same — the Zitadel resources read DB
  outputs),
- IAM bindings + service accounts that the GKE/Cloud-SQL outputs
  flowed through.

A "delete the ~9 Cloud-tenant Zitadel resources" invocation
cascade-removed **87 resources** from state — GKE, Postgres, GSM,
IAM, the works — because every one of those was a transitive
dependent of *something* in the targeted set. The cloud-side
resources were all still alive; only the state file was wrong.

This is the §13.4 incident, archived in `specification`:
`openspec/changes/archive/2026-05-11-self-hosted-zitadel/tasks.md`
(search for "13.4").

## Recovery procedure

The five-step procedure below assumes:

1. The cascade has already happened (you are post-incident, not
   mid-incident).
2. Cloud-side resources are intact — `gcloud` / Pulumi Cloud / the
   Console all show the resources still exist.
3. You have shell access to a workstation with `pulumi` CLI logged
   in to the affected stack.

If any of these are false, stop and re-scope.

### Step 1 — snapshot a pre-incident stack version

Pulumi Cloud retains every stack version indefinitely. Find the last
version *before* the cascade and export it:

```bash
cd ~/dev/src/github.com/liverty-music/cloud-provisioning

# List recent versions; identify the last version before the bad
# `pulumi state delete` (look at timestamps + version numbers).
pulumi stack history -s dev --page-size 30

# Export the chosen pre-incident version to a JSON file.
PRE_INCIDENT_VERSION=246   # ← the §13.4 incident value; YOURS WILL DIFFER
pulumi stack export -s dev --version "$PRE_INCIDENT_VERSION" \
  > /tmp/pulumi-state-pre-incident.json

# Also export the current (post-cascade) version for the merge step.
pulumi stack export -s dev > /tmp/pulumi-state-current.json
```

Sanity check the file sizes — the pre-incident snapshot should be
materially larger than the current state if the cascade removed
resources.

### Step 2 — construct the merged-state JSON

You need a single JSON file containing **every resource the stack
should currently own** — the union of:

- the current state (what survived the cascade), and
- the missing-resource superset from the pre-incident snapshot,

minus any obsolete entries (resources that *should* be gone — e.g.
the Zitadel v1 Actions resources that the cutover deliberately
removed). Filter those out from the pre-incident snapshot before
merging.

```bash
# Quick inventory of what each file contains (resource URNs).
jq -r '.deployment.resources[].urn' /tmp/pulumi-state-current.json \
  | sort > /tmp/urns-current.txt
jq -r '.deployment.resources[].urn' /tmp/pulumi-state-pre-incident.json \
  | sort > /tmp/urns-pre-incident.txt

# Resources that exist in pre-incident but not in current — these are
# the cascade victims you need to restore.
comm -23 /tmp/urns-pre-incident.txt /tmp/urns-current.txt \
  > /tmp/urns-missing.txt
wc -l /tmp/urns-missing.txt
```

Hand-merge the JSON. `jq` works for the simple case (additive
merge with no conflicts): take the URN list as a raw newline-delimited
string, parse it into an array, select those URNs out of the
pre-incident snapshot, and append them onto the current state's
resource array.

```bash
# Pull the missing resources out of the pre-incident snapshot and
# append them to the current state.
jq \
  --slurpfile pre /tmp/pulumi-state-pre-incident.json \
  --rawfile missing_urns /tmp/urns-missing.txt '
    ($missing_urns | split("\n") | map(select(length > 0))) as $urns
    | .deployment.resources |= (. + (
        $pre[0].deployment.resources
        | map(select(.urn as $u | $urns | index($u) != null))
      ))
  ' /tmp/pulumi-state-current.json > /tmp/pulumi-state-merged.json
```

Note: `--slurpfile pre` reads the JSON snapshot (wrapping it in a
single-element array, hence `$pre[0]`); `--rawfile missing_urns`
reads the plain-text URN list as a raw string, which we then split
on newlines and drop empty entries.

For more complex cascades (multiple snapshots, structural edits, or
conditional URN rewrites) script this with a small Python or `jq`
pipeline tailored to the specific incident — the §13.4 recovery ran
a one-off script. The key invariants are:

1. **No duplicate URNs** after merge.
2. **Dependency ordering preserved** — pull resources in the order
   they appear in the pre-incident snapshot (Pulumi tolerates
   re-ordering but it makes diffs harder to read).
3. **Filter obsolete entries** — resources that were deliberately
   removed (e.g. v1 components superseded by v2) must NOT come back
   from the snapshot. List them explicitly and `jq del(...)` before
   merging.

Validate the structure of the merged file:

```bash
jq '.deployment.resources | length' /tmp/pulumi-state-merged.json
jq '.deployment.resources[].urn' /tmp/pulumi-state-merged.json \
  | sort | uniq -d
# expected: empty (no duplicate URNs)
```

### Step 3 — import the merged JSON

```bash
pulumi stack import -s dev --file /tmp/pulumi-state-merged.json
```

The import succeeds even when the state contains internal artifacts
that the next operation cannot tolerate (see step 4). Confirm the
new version was written:

```bash
pulumi stack history -s dev --page-size 3
# expected: a new top-of-history entry, "update" with the import.
```

### Step 4 — scrub `__pulumi_raw_state_delta` (known-bug workaround)

A successful `stack import` is not yet a safe stack. On the **next
operation after import** (typically the `pulumi preview` in step 5),
the GCP provider panics on resources that carry a stale
`__pulumi_raw_state_delta` internal field. The §13.4 recovery hit
this on 177 resources.

This is a known-bug workaround as of Pulumi v3.x / pulumi-gcp v8.x
at recovery time. Re-check whether the bug is still present before
applying — if upstream has fixed it, this step is unnecessary.

Re-export the just-imported state, scrub the field, and re-import:

```bash
pulumi stack export -s dev > /tmp/pulumi-state-imported.json

# Strip __pulumi_raw_state_delta from every resource's `inputs` and
# `outputs` (it may appear under either, depending on resource).
jq '
  .deployment.resources |= map(
    if .inputs  then .inputs  |= del(.__pulumi_raw_state_delta) else . end
    | if .outputs then .outputs |= del(.__pulumi_raw_state_delta) else . end
  )
' /tmp/pulumi-state-imported.json > /tmp/pulumi-state-scrubbed.json

# Sanity: confirm the field is gone everywhere.
jq '.deployment.resources[] | (.inputs?, .outputs?) | .__pulumi_raw_state_delta' \
  /tmp/pulumi-state-scrubbed.json | grep -c '^null$'
# expected: a count equal to (resource_count * 2) — every slot is null.

pulumi stack import -s dev --file /tmp/pulumi-state-scrubbed.json
```

### Step 5 — verify with a clean preview

```bash
pulumi preview -s dev
```

**Expected output:** *no changes*, or only the small set of
genuinely-desired changes that motivated the original work session.
A clean preview with `0 to create, 0 to update, 0 to delete` is the
canonical "recovery succeeded" signal.

If preview returns a panic, re-check step 4 (the scrub may have
missed some inputs/outputs path — providers occasionally nest the
field). If preview returns a large delete diff, the merge in step 2
was incomplete — re-derive the missing-URN set and merge again.

Once preview is clean, **do not run `pulumi up` from your
workstation** for the dev stack. Per
[`CLAUDE.md`](../../CLAUDE.md) → "Pulumi Deployments (Automated)",
dev `pulumi up` is run by Pulumi Cloud Deployments on PR merge.
The state recovery itself is a state-only edit — it does not need a
deployment to take effect.

## What this runbook is NOT for

- **Normal resource destroys.** Use `pulumi destroy --target <urn>`
  (visible to PR reviewers via `previewPullRequests=true`). The
  `state delete --target-dependents` flag should not be in your
  toolkit for any planned change.
- **Re-importing a single resource the provider panicked on.** Use
  `pulumi state delete <urn>` (no `--target-dependents`) + `pulumi
  import`. Surgical, no transitive blast.
- **Cloud-side resource loss.** If the cloud-side resource is
  genuinely gone (e.g. someone deleted the GKE cluster from the
  Console), the answer is `pulumi up` against a clean state and let
  Pulumi recreate it. Recovering the state file when the underlying
  resource is gone just produces drift.
- **General Pulumi state edits.** Single-field fix-ups (e.g.
  patching an `outputs.something` value) are best done with `pulumi
  state edit` interactively, not via stack import.

## Reference

- OpenSpec spec: `pulumi-state-recovery` (added via `specification`
  PR #442 / change `pulumi-state-recovery-runbook`).
- §13.4 worked example: `specification`
  `openspec/changes/archive/2026-05-11-self-hosted-zitadel/tasks.md`
  line 114 (search "13.4").
- §18.9 follow-up tracking: same archive, search "18.9".
- Pulumi Cloud `previewPullRequests` (the existing layer that covers
  the code-driven cascade scenario):
  `Pulumi.dev.deploy.yaml` → `previewPullRequests: true`.
- Related runbook: [`zitadel-break-glass.md`](zitadel-break-glass.md)
  (similar "your normal Pulumi flow is broken, here's the recovery
  path" shape, but for Zitadel admin identity).
