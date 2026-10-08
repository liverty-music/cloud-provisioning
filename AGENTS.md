<poly-repo-context repo="cloud-provisioning">
  <responsibilities>GCP infrastructure via Pulumi (TypeScript). Kubernetes manifests
  managed by ArgoCD with Kustomize base/overlays. Multi-environment (dev/prod).</responsibilities>
  <essential-commands>
    pulumi preview         # Preview infra changes
    pulumi up              # Deploy (requires user approval)
  </essential-commands>
</poly-repo-context>

<agent-rules>

## OpenSpec (planning lives in the store)

This repository carries no planning of its own. `openspec/config.yaml` declares `store: openspec-store` (the `liverty-music/specification` repository), so every `openspec` command run here resolves to that store; the `Using OpenSpec root: openspec-store` banner confirms it. The full workflow, local and cloud, is in the `specification` README ("Development workflow"); the rules that bind a session here are:

- **Before implementing**, read the change's artifacts and the affected specs in the store: `openspec show <change>`, `openspec instructions apply --change <change>`, and `openspec show <spec-id> --type spec`. Implement against the spec, not against memory.
- **Run `openspec doctor` first** on a fresh machine and at the start of every cloud thread. If the store is not registered, register a `specification` checkout: the sibling clone when one exists (`openspec store register "$(git rev-parse --show-toplevel)/../specification" --id openspec-store`, the layout of a multi-repo Claude Project thread), otherwise clone the public repo first (`git clone --depth 1 https://github.com/liverty-music/specification.git /tmp/openspec-store`) and register that path. Keep that checkout on `main` and pull it before implementing: OpenSpec never pulls.
- **Isolate local work with `claude --worktree <change>`** (`.claude/worktrees/<change>`, branch `worktree-<change>`). In `specification`, the main checkout is the shared store and stays on `main`; branch work there (plan PR, proto PR, archive) goes through its own worktrees (`specification` README "Branch work in this repository").
- **Record progress in the store, never commit there.** `/opsx:apply` checks off `tasks.md` and updates `design.md` in the `specification` checkout's working tree on `main`, uncommitted. Several changes share that working tree, so never run `git stash`, `git reset --hard`, `git checkout -- .` / `git restore .` or `git clean` there, never `git add -A` / `git add .`, and never switch its branch.
- **Every PR must cite its change**: fill the `OpenSpec-Change` (or `OpenSpec-Spec`) field and the store commit SHA in the PR template's OpenSpec Traceability section. One PR per repository.
- **Close-out happens in `specification`**, after every implementing PR has merged and the release is confirmed in production: `/opsx:verify`, then archive in a `<change>-archive` worktree of `specification`, staging only that change's paths (README "Lifecycle of a change", step 5). Do not archive from this repository.
- **Cloud threads run no repository hooks**: run `make check` before committing; CI is the gate.

## Cross-repo workflow (poly-repo)

This repo is one of four under `liverty-music/`: `specification` (proto schema + OpenSpec store), `backend`, `frontend`, `cloud-provisioning`. Infrastructure here is not gated by the proto release flow (that process lives in the specification repo's AGENTS.md). When a change spans repositories, keep this repo's PR independently mergeable and cite the same OpenSpec change in every PR so reviewers can follow the set.

## Operating Protocols

### Pulumi Deployment Approval

Before executing `pulumi up` or any deployment command, follow this workflow:

1. **Preview first**: Run `pulumi preview` (or `pulumi preview --diff`)
2. **Present to user**: Show the preview output, highlight destructive operations (deletions, replacements)
3. **Wait for explicit approval**: Do not proceed until the user says "yes", "proceed", or "approve"
4. **Execute**: Only after approval, run `pulumi up`

Never skip this workflow, even for small changes. Exception: the user has given explicit advance authorization for a specific deployment in the current session.

### Pulumi Deployments (Automated)

**dev**: Merging a PR to `main` with changes under `src/**` automatically
triggers `pulumi up` via Pulumi Cloud Deployments.
Never run `pulumi up` locally for dev — it conflicts with the automated job.
Monitor: https://app.pulumi.com/pannpers/liverty-music/dev/deployments

**prod**: PRs trigger `pulumi preview` only. `pulumi up` does not run
automatically on merge. Trigger manually from the Pulumi Cloud console:
https://app.pulumi.com/pannpers/liverty-music/prod/deployments

### Pulumi State Recovery

Before considering `pulumi state delete --target-dependents` (its
blast radius follows ALL transitive dependents, not just the
ComponentResource subtree — the §13.4 cutover incident
cascade-removed 87 resources from ~9 intended targets) **or**
when recovering from a post-incident state cascade, read
[`docs/runbooks/pulumi-state-recovery.md`](docs/runbooks/pulumi-state-recovery.md).
The runbook documents the preferred path (`pulumi destroy --target`
through normal `preview → up`, visible via Pulumi Cloud's
`previewPullRequests`) and the five-step recovery procedure
(snapshot, merge, import, scrub `__pulumi_raw_state_delta`, verify
clean preview) for when the cascade has already happened.

### Kubernetes Manifests

Before committing changes under `k8s/`, follow the dry-run and dev cost checks in `k8s/CLAUDE.md`.

Do not commit if `kubectl kustomize` returns an error or patches are missing.

## ESC Secret Management

This project uses Pulumi ESC (Environment, Secrets, and Configuration) for all configuration and secrets.

### ESC Environment Hierarchy

```
liverty-music/common          ← shared config inherited by all envs
├── liverty-music/dev          ← dev-specific config (imports common)
└── liverty-music/prod         ← prod-specific config (imports common)

liverty-music/cloud-provisioning/common  ← project-level shared config
├── liverty-music/cloud-provisioning/dev  ← project dev (imports above)
└── liverty-music/cloud-provisioning/prod
```

### `pulumi env set` vs `pulumi config set`

This distinction is critical — using the wrong command stores secrets in the wrong location:

- **`pulumi config set --secret`**: Writes to the stack YAML file or common ESC environment. Wrong for environment-specific secrets.
- **`pulumi env set`**: Writes directly to a specific ESC environment. This is the correct approach. (The standalone `esc` CLI is retired; `esc env set` takes the same arguments.)

Pass a secret value with `--file` (a file path, or `-` for stdin), never as a command-line argument. An argument lands in shell history and process listings, and a value starting with `-` (a PEM key, `-----BEGIN ...`) is parsed as a flag: the CLI then prints the whole value in its error message.

```bash
# Correct: writes to liverty-music/dev ESC environment; the value never appears on the command line
pulumi env set liverty-music/dev pulumiConfig.gcp.someSecret --file ./some-secret.txt --secret --string

# Wrong: may write to common env or stack file
pulumi -s dev config set --secret --path 'liverty-music:gcp.someSecret' "value"
```

### ESC Path Mapping

| ESC Path | Pulumi Config Key |
|----------|-------------------|
| `pulumiConfig.gcp.billingAccount` | `liverty-music:gcp.billingAccount` |
| `pulumiConfig.gcp.postgresAdminPassword` | `liverty-music:gcp.postgresAdminPassword` |
| `pulumiConfig.github.token` | `liverty-music:github.token` |

## Configuration

Store secrets in Pulumi ESC — hardcoded secrets in code are exposed in version control. Use IAM roles instead of service account keys. Use GCP Secret Manager for application secrets.

## Code Conventions

- Use kebab-case for Pulumi resource names: `my-storage-bucket`
- GCP regions and zones are defined in `src/gcp/region.ts` (`asia-northeast2` / Osaka)

## Review criteria (flag violations)

- Environment-specific secrets use `pulumi env set ... --file`, never `pulumi config set --secret`, a command-line value, or a hardcoded value.
- Renaming a lifecycle-sensitive resource (MachineKey, IAM/SA keys) uses `aliases: [{ name: 'old-urn' }]` to avoid replace-delete.

</agent-rules>
