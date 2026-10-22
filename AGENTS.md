<poly-repo-context repo="cloud-provisioning">
  <responsibilities>GCP, Cloudflare, GitHub and Zitadel resources via Pulumi (TypeScript).
  Kubernetes manifests applied by ArgoCD from Kustomize base/overlays. Stacks: dev, prod.</responsibilities>
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

## Scope of this file

General Pulumi practice comes from the `pulumi` plugin skills enabled in `.claude/settings.json` (`pulumi-best-practices`, `provider-upgrade`, `pulumi-debug-failed-operation`, ...). This file holds only what is specific to this repository; where it disagrees with a skill, this file wins.

## Deployments

- **dev is stopped indefinitely** to save cost (`liverty-music:workloadEnabled: "false"` in `Pulumi.dev.yaml`): its cluster and workloads do not exist. Verify changes in prod with unit tests and read-only checks, and do not plan work that needs dev running.
- **dev**: merging to `main` runs `pulumi up` via Pulumi Cloud Deployments. Agents may also run `pulumi up -s dev` locally after showing the preview and getting the user's approval; the next merge to `main` re-applies `main`, so a branch applied this way is temporary.
- **prod**: agents run `pulumi preview` and read-only state commands only. The user triggers `pulumi up` from the Pulumi Cloud console (https://app.pulumi.com/pannpers/liverty-music/prod/deployments). Write out any `destroy`, `refresh`, `import` or `state` command for the user instead of running it.
- **Pull-request previews** run on Pulumi Cloud Deployments, triggered by the `paths` in `src/pulumi-cloud/deployment-settings.ts`. Do not add a GitHub Actions preview or up job (design D6 of `automate-dependency-updates`), and do not add dependency manifests to `paths`.

## Changing Pulumi code

- Introduce a `ComponentResource` only after working out which resources outside it will need to reference its children. Moving an existing resource under a parent changes its URN and needs `aliases`. `Gcp` in `src/gcp/index.ts` stays a plain class on purpose.
- Resource names are kebab-case. Regions and zones come from `src/gcp/region.ts`.
- **Provider upgrades** (the Renovate `pulumi` group, which never automerges and is not previewed by Pulumi Cloud): run the `provider-upgrade` skill on the Renovate branch against both stacks, and post its Upgrade Summary as a comment on that pull request instead of opening a new one. A preview of `main` is not empty: compare against the baseline table in "A Pulumi preview reports resource changes" (`liverty-music/.github` `renovate-runbook.md`) before attributing a diff to the upgrade.

## Configuration and secrets

- Stacks import the ESC environments `liverty-music/dev` and `liverty-music/prod`, which both import `liverty-music/common`. ESC `pulumiConfig.<key>` is the config key `liverty-music:<key>`.
- Set an environment-specific value with `pulumi env set liverty-music/<env> pulumiConfig.<key> --file <path|-> [--secret --string]`. Never use `pulumi config set --secret` (it writes to the stack file), and never pass a value as an argument: it lands in shell history, and a value starting with `-` (a PEM key) is parsed as a flag and echoed in the error.

## Public repository

- **This repository is public**, and so are its Issues, PRs, commit messages and Actions logs. Never write production user data there: no emails, names, user or order IDs, payment or Stripe customer IDs, or log lines that carry them. Quote an ID only when it identifies a resource, not a person, and summarize user-bearing logs instead of pasting them. The same holds for `backend`, `frontend`, `specification` and `.github`.
- **Visibility is set per repository** in `src/github/components/organization.ts` (`REPOSITORY_VISIBILITY`). Before changing it, follow `docs/runbooks/repository-visibility.md`.

## Before you act on

- **`pulumi state delete --target-dependents`, or recovery from a state cascade**: read `docs/runbooks/pulumi-state-recovery.md` first. The blast radius follows all transitive dependents, not just a component's subtree; one incident removed 87 resources instead of ~9.
- **Changes under `k8s/`**: follow `k8s/AGENTS.md`.

</agent-rules>
