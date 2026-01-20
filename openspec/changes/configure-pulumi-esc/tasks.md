## 0. Provision GCP Infrastructure (WIF)

- [x] 0.1 Implement `WorkloadIdentityFederation` component in Pulumi.
- [x] 0.2 Instantiate the component in `src/index.ts` for `dev` and `prod`.
- [x] 0.3 Run `pulumi up` locally to provision WIF resources in both environments.

## 1. Configure Stack OIDC Settings (Pulumi Console)

- [x] 1.1 In Pulumi Cloud, navigate to `dev` stack > Settings > Deploy.
- [x] 1.2 Enable "Google Cloud Integration".
- [x] 1.3 Enterprise GCP Project ID: `liverty-music-dev`.
- [x] 1.4 Workload Identity Pool ID: `external-providers`.
- [x] 1.5 Workload Identity Provider ID: `pulumi-provider`.
- [x] 1.6 Service Account Email: `pulumi-cloud@liverty-music-dev.iam.gserviceaccount.com`.
- [x] 1.7 Repeat steps 1.1–1.6 for the `prod` stack using `liverty-music-prod`.

## 2. Configure Git Source and Triggers

- [x] 2.1 Set up GitHub repository as the source in the "Deploy" settings.
- [x] 2.2 Enable "Managed Previews" (PR triggers).
- [x] 2.3 Enable "Managed Updates" (Main branch merge triggers for `dev` only).

## 3. Verification

- [ ] 3.1 Trigger PR: Verify `dev` and `prod` stacks both run `preview`.
- [ ] 3.2 Verify preview results are commented in the PR.
- [ ] 3.3 Merge PR: Verify `dev` stack runs `up`.
- [ ] 3.4 Manually trigger `up` for `prod` via Dashboard.
- [ ] 3.5 Delete `.github/workflows/pulumi-*.yml`.
