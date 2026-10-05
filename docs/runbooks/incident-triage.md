# Runbook: automated incident triage

Every incident ArgoCD can detect in prod is investigated by Claude, read-only, and
reported as a GitHub Issue labelled `incident` in `cloud-provisioning`, before anyone
has to open a terminal. Claude's report is advisory: it never changes the cluster, GCP
or Git. A human reads it, decides, and acts.

OpenSpec change: `autonomous-incident-response` (design decisions D1–D12 are cited below).

## Architecture

```
ArgoCD Notifications (argocd ns)
  │  trigger fires: on-sync-failed | on-health-degraded |
  │                 on-health-progressing-stuck | on-sync-status-unknown
  ├──► Google Chat (message part of the template, unchanged)
  └──► webhook `incident-triage` (webhook part of the same template)
         POST https://api.github.com/repos/liverty-music/cloud-provisioning/
              actions/workflows/incident-triage.yml/dispatches
         Authorization: Bearer <cluster-bot installation token, 1h>
               ▲
               │ ESO GithubAccessToken generator, refreshed every 30m into
               │ argocd-notifications-secret[github-token]
               │ from the App private key (Secret Manager → ExternalSecret)
               ▼
.github/workflows/incident-triage.yml (workflow_dispatch; inputs app, trigger, payload)
  gate   ── environment `prod`: reads INCIDENT_TRIAGE_ENABLED (kill switch)
  triage ── WIF → incident-triage SA (read-only) → kubeconfig for autopilot-cluster-osaka
            claude-code-action + .claude/skills/incident-triage → triage-report.md (artifact)
  report ── issues: write; scans the report for credentials, then creates
            `[incident] <app>: <trigger>` or comments on the open Issue for <app>
```

| Piece | Where |
|---|---|
| Triggers, templates, webhook service | `k8s/namespaces/argocd/base/values.yaml` (`notifications:`) |
| Token generator + private-key ExternalSecret | `k8s/namespaces/argocd/base/github-access-token.yaml` |
| `argocd-notifications-secret` (Google Chat URL + `github-token`) | `k8s/namespaces/argocd/base/external-secret.yaml` |
| Secret Manager secret `argocd-cluster-bot-private-key` | `src/gcp/index.ts` (`esoOnlySecrets`) |
| `incident-triage` SA, roles, WIF binding | `src/gcp/components/workload-identity.ts` |
| `prod` environment variables | `src/index.ts` (cloud-provisioning repository) |
| `incident` label | created by the `report` job (`gh label create --force`); not in Pulumi because label writes need Issues: write, which the Pulumi GitHub token lacks |
| ArgoCD-control-plane-down alert | `src/gcp/components/monitoring.ts` |
| Workflow | `.github/workflows/incident-triage.yml` |
| Investigation procedure and report template | `.claude/skills/incident-triage/SKILL.md` |

## Kill switch

The `prod` environment variable `INCIDENT_TRIAGE_ENABLED` on `cloud-provisioning`
(**Settings → Environments → prod → Environment variables**). Anything other than
`true` makes the `gate` job skip `triage` and `report`; no Claude run, no Issue. It
takes effect on the next dispatch.

```bash
gh variable set INCIDENT_TRIAGE_ENABLED --env prod --body false --repo liverty-music/cloud-provisioning
```

Pulumi creates the variable as `false` and ignores later value changes, so flipping it
in the UI or with `gh` is not reverted by `pulumi up`. Google Chat notifications are
independent of the switch.

To also stop dispatches at the source (e.g. a notification storm), remove
`incident-triage` from `notifications.subscriptions` in `values.yaml`.

## Reading and closing an `incident` Issue

- Title `[incident] <app>: <trigger>`. Later dispatches for the same Application add a
  comment to the open Issue instead of opening a new one; close the Issue once the
  incident is resolved so the next one starts fresh.
- Runs started by hand (any actor other than `liverty-music-cluster-bot[bot]`) are
  titled `[incident] [manual] <app>: <trigger>`, so they never merge with a real
  incident for the same Application. Close them when done.
- Each post links its workflow run and ends with the ArgoCD status at dispatch time
  (collapsed), which is there even when Claude produced nothing.
- A **warning** at the top means the run did not succeed and names the stage: setup
  before Claude (checkout, GCP auth, GKE credentials, dependency install), Claude Code
  failing to start, Claude not finishing (error or the `--max-turns 25` cap), or the job
  timing out. With a partial report it may be the early draft; otherwise the post says
  no report was produced.
- **Report withheld** means the report contained the Claude OAuth token or a GCP access
  token pattern (`ya29.`) and was not posted. Treat it as a possible prompt-injection
  attempt: open the run, check what the triage did, and rotate `CLAUDE_CODE_OAUTH_TOKEN`
  if the token value itself appeared.
- Check the report's **Confidence** and **Not checked** sections before acting. It is
  advisory; suggested commands must be run by an operator
  ([prod-cluster-credentials.md](prod-cluster-credentials.md)).
- ArgoCD notifies once per condition: an app that stays broken does not re-dispatch
  until the condition clears and recurs.

Re-run a triage by hand (e.g. after widening the allowlist):

```bash
gh workflow run incident-triage.yml --repo liverty-music/cloud-provisioning \
  -f app=<application> -f trigger=manual -f payload='{}'
```

It runs only while the kill switch is `true`, and posts to a `[manual]` Issue.

## Known detection gaps (D1)

ArgoCD Notifications is the only trigger. Not covered:

- Application-level failures that Kubernetes health does not see: ERROR logs, JetStream
  backlog stalls, poison messages, goroutine leaks, Web Push delivery failures. These
  stay on the Cloud Monitoring → Slack / Google Chat path.
- Pulumi-managed resources (Cloud SQL, IAM, networking, Secret Manager).
- A CronJob that has never succeeded (no custom Lua health check).
- A container that passes readiness, runs for a while and then exits (OOM under load,
  a panic after some minutes, a dropped dependency). Argo CD reports a Deployment as
  Healthy whenever its replicas are available at evaluation time, so every restart
  flips the Application back to Healthy and resets the 15-minute
  `on-health-progressing-stuck` timer. Confirmed in the 2026-10-05 end-to-end test.
  The **Container Crash Loop** Cloud Monitoring alert (more than 3 restarts in 30
  minutes, any namespace) covers it for humans; dispatch a triage by hand if needed.
  A container that crashes before readiness on every restart stays Progressing and
  is caught.
- ArgoCD itself being down — covered instead by the **ArgoCD Control Plane Down** Cloud
  Monitoring alert, routed to the human channels. While it is open, triage is blind.

## Permission boundary (D8, D9)

The triage job authenticates through the GitHub WIF provider as
`incident-triage@<project>.iam.gserviceaccount.com`, which holds exactly:

| Role | Gives | Deliberately excludes |
|---|---|---|
| `roles/container.viewer` | Kubernetes objects, CRDs (Applications, ScaledObjects, ExternalSecrets), events | `pods/log`, `pods/exec`, Secrets, any write |
| `roles/logging.viewer` | Cloud Logging, incl. stdout/stderr of every container instance | — |

Any `cloud-provisioning` workflow can impersonate this SA; that is acceptable because it
is read-only.

Claude Code's allowlist in the workflow (`settings`): `kubectl get|describe|events`,
`gcloud logging read`, `gcloud container clusters describe`, `git log|show`, `Read` /
`Glob` / `Grep` in the checkout (excluding `gha-creds-*.json` and `gha-kubeconfig-*`), `Write` / `Edit` on `triage-report.md` only. Denied: `kubectl`
`--server` / `-s` / `--kubeconfig` / `--token`, `gcloud` `--access-token-file` /
`--impersonate-service-account`, `git --output`, `env` / `printenv`, web and GitHub MCP
tools. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes the Anthropic credential from Bash
subprocesses (it requires bubblewrap, which the job installs before the Claude step;
without it Claude Code refuses to start), and the job's `GITHUB_TOKEN` is read-only.
Because the scrubbing also removes credential environment variables, the job registers
the GCP credential in gcloud's config (`setup-gcloud`) and copies the kubeconfig to
`~/.kube/config` instead of relying on `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` /
`KUBECONFIG`. With the scrubbing enabled, Claude Code also applies the Read deny rules
as OS-level read denials to every Bash subprocess, so the deny list must never include
a path an allowed command needs (`.git`, `~/.kube`, `~/.config/gcloud`). Commands must put the subcommand first (`kubectl get pods -n x`, not
`kubectl -n x get pods`): the allowlist is a prefix match. The Issues-write token exists
only in the `report` job, where Claude never runs.

Widen the allowlist only with read-only subcommands, after reviewing real runs whose
"Not checked" sections show the need.

## `liverty-music-cluster-bot` GitHub App (D4)

The second org App, beside `liverty-music-ci-bot`
([prod-image-tag-pinning.md](prod-image-tag-pinning.md#1-cross-repo-dispatch-credential-github-app-liverty-music-ci-bot)).
It is named for where its key lives (the cluster), and its permission is **Actions:
write** only (plus the implicit Metadata: read), installed on `cloud-provisioning` only.
It is a separate App because whoever holds an App's private key can mint tokens with all
of that App's permissions: ci-bot's key would let a cluster compromise push to
`cloud-provisioning:main`, cluster-bot's cannot.

### One-time setup

1. **Organization settings → Developer settings → GitHub Apps → New GitHub App**. Name
   `liverty-music-cluster-bot`; uncheck **Webhook → Active**; **Repository permissions →
   Actions: Read and write**, nothing else; **Only on this account**. Create.
2. **Install App → Only select repositories → `cloud-provisioning`**. Note the
   installation ID from the installation URL
   (`.../settings/installations/<installation-id>`), and the **App ID** from the App's
   General page. Both are non-secret; they go into `github-access-token.yaml`
   (App ID `5190363`, installation ID `167958034`).
3. Confirm the scope:
   ```bash
   gh api /orgs/liverty-music/installations \
     --jq '.installations[] | select(.app_slug=="liverty-music-cluster-bot") | {permissions, repository_selection}'
   # → {"permissions":{"actions":"write","metadata":"read"},"repository_selection":"selected"}
   ```
4. **Generate a private key** and store it in ESC, then run the prod `pulumi up`
   (creates the Secret Manager secret `argocd-cluster-bot-private-key`):
   ```bash
   pulumi env set liverty-music/prod pulumiConfig.gcp.argocdClusterBotPrivateKey \
     --file liverty-music-cluster-bot.<date>.private-key.pem --secret --string
   ```
   Always pass the key with `--file`, never as an argument (`"$(cat key.pem)"`): the
   value starts with `-----BEGIN`, the CLI parses it as a flag, and the error message
   prints the whole key.
   Delete the downloaded `.pem` afterwards.

### Private-key rotation (also the response to a suspected compromise)

1. On the App's General page, **Generate a private key** (the old key stays valid).
2. `pulumi env set liverty-music/prod pulumiConfig.gcp.argocdClusterBotPrivateKey --file <new>.pem --secret --string`,
   then trigger the prod `pulumi up` (a new Secret Manager version).
3. Force ESO to pick it up instead of waiting for the refresh interval:
   ```bash
   kubectl -n argocd annotate externalsecret argocd-cluster-bot-private-key force-sync=$(date +%s) --overwrite
   kubectl -n argocd annotate externalsecret argocd-notifications-secret force-sync=$(date +%s) --overwrite
   ```
4. Verify both ExternalSecrets are `Ready=True` (`kubectl -n argocd get externalsecret`).
5. **Delete the old key** on the App's General page. Installation tokens minted from it
   stay valid until they expire (at most 1 hour).

A compromised key lets the holder start, re-run, cancel or disable workflows in
`cloud-provisioning` (see the gating rule below), not push code. If compromise is
suspected, also review **Actions** run history for runs started by
`liverty-music-cluster-bot[bot]`.

## Workflow-gating rule (D3)

Actions: write can start existing workflows on existing refs and re-run past runs, so its
reach is whatever those workflows can do behind their own gates. Rule:

> **Every `cloud-provisioning` workflow that holds a write-capable credential and accepts
> `workflow_dispatch` must be Environment-gated (required reviewers).**

Audit (2026-10-04, `.github/workflows/`):

| Workflow | Triggers | Write-capable credential | Reachable by Actions: write | Gate |
|---|---|---|---|---|
| `bump-prod-pin.yml` | `repository_dispatch`, `workflow_dispatch` | ci-bot token (pushes `main`) | `workflow_dispatch`; re-run of a past run | `workflow_dispatch` runs in the `prod-pin` Environment (admin approval, also on re-run); a re-run `repository_dispatch` replays its own tag — idempotent no-op or rejected by the no-downgrade guard |
| `claude.yml` | `issue_comment`, `pull_request_review_comment`, `issues`, `pull_request_review` | Claude App token (cannot reach `main`: ruleset) | re-run only | repeats a request a human already made |
| `claude-code-review.yml`, `ci.yml`, `lint.yml` | `pull_request` / `push` | none (read-only) | re-run only | — |
| `incident-triage.yml` | `workflow_dispatch` | `issues: write` in `report` only | dispatch (intended) | kill switch; read-only GCP identity |

`bump-prod-pin.yml` is the only privileged `workflow_dispatch` path and it is gated, so
the rule holds. Re-run this audit whenever a workflow gains `workflow_dispatch` or a
write-capable credential.

## Token freshness

ESO rewrites `argocd-notifications-secret` every 30 minutes with a token valid for 60,
so the Secret always holds a live token. Whether the notifications controller picks up
the rewritten Secret without a restart is verified in the end-to-end test (a dispatch
more than 60 minutes after the first token). If dispatches fail with `401`
in the controller logs (`kubectl -n argocd logs deploy/argocd-notifications-controller`),
check that `argocd-notifications-secret` is `Ready=True` and its `github-token` key is
recent; if the controller turns out to cache the token, add a Reloader annotation for
the Secret to the controller.

## External Secrets failures

The triage path depends on ESO in two places: the private-key ExternalSecret and the
generator-backed `argocd-notifications-secret`. If either is not `Ready`:

1. `kubectl -n argocd describe externalsecret <name>` — the condition names the failure
   (missing Secret Manager key, accessor binding, generator error such as a wrong App ID /
   installation ID or a revoked key).
2. If many ExternalSecrets cluster-wide are failing, see the **ClusterSecretStore Not
   Ready** alert documentation in `src/gcp/components/monitoring.ts`
   (`kubectl rollout restart deployment external-secrets -n external-secrets`).
3. Note that a failing `argocd-notifications-secret` also stops the Google Chat
   notifications (same Secret).
