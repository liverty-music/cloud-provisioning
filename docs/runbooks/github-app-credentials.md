# GitHub credentials for Pulumi (`liverty-music-pulumi` App)

The Pulumi GitHub provider (`src/github/`) authenticates as an organization-owned
GitHub App, not as a personal access token. An App does not depend on one
person's account, its installation tokens expire after an hour, and its
permissions are edited on its settings page instead of by minting a new token.

This is a manual setup because it is one of the cases `AGENTS.md` allows for a
manual step: GitHub has an API for registering an App (the manifest flow), but
it still needs a person to confirm on a GitHub page, and the Pulumi GitHub
provider has no resource that creates an App (only `AppInstallationRepository`
and `AppInstallationRepositories`, which link an existing installation to
repositories and do not work with App authentication).

- App: https://github.com/organizations/liverty-music/settings/apps/liverty-music-pulumi
- Installed on: every repository of `liverty-music`.
- Not the same as `liverty-music-ci-bot`. That App is the bypass actor of the
  `main` ruleset and is used by release workflows; this one can change
  repository settings, so the two stay apart.

## Permissions

| Scope | Permission | Access | Needed by |
|---|---|---|---|
| Repository | Administration | Read and write | `Repository`, `BranchProtection`, `RepositoryRuleset`, vulnerability alerts, security settings |
| Repository | Contents | Read and write | creating a repository from a template |
| Repository | Environments | Read and write | `RepositoryEnvironment`, deployment policies, environment secrets and variables |
| Repository | Secrets | Read and write | `ActionsSecret`, `ActionsEnvironmentSecret` |
| Repository | Variables | Read and write | `ActionsVariable`, `ActionsEnvironmentVariable` |
| Repository | Pages | Read and write | `RepositoryPages` (`specification-pages`) |
| Repository | Metadata | Read | always |
| Organization | Administration | Read and write | `OrganizationSettings` |
| Organization | Secrets | Read and write | `ActionsOrganizationSecret` |

When a `pulumi up` fails with `403 Resource not accessible by integration`, the
App lacks the permission its resource needs. Add it on the App's settings page
(Permissions & events). The organization owner then has to accept the new
permission on the installation. No new credential is needed.

## Configuration

ESC `liverty-music/common` (read by both stacks) holds three keys under
`pulumiConfig.github`:

| Key | Value |
|---|---|
| `pulumiAppId` | the App ID, shown on the App's settings page |
| `pulumiAppInstallationId` | the number at the end of the installation URL (`.../settings/installations/<id>`) |
| `pulumiAppPrivateKey` | the App's private key (PEM), a secret |

Set the key from a file, never as an argument:

```sh
pulumi env set liverty-music/common pulumiConfig.github.pulumiAppPrivateKey \
  --file <path-to-pem> --secret --string
```

Delete the downloaded PEM once it is in ESC.

## Rotating the private key

1. On the App's settings page, generate a new private key and download it.
2. Set it in ESC with the command above.
3. Run a prod `pulumi up` (Pulumi Cloud) and check that it succeeds.
4. Delete the old key on the App's settings page, then delete the downloaded PEM.

## Creating the App again

Register it in the organization's settings (Developer settings → GitHub Apps) with
no webhook, no user authorization and the permissions above, install it on all
repositories, generate a private key, and set the three ESC keys.
