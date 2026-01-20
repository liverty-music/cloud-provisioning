## 0. Provision GCP Infrastructure (WIF)

- [ ] 0.1 Implement `WorkloadIdentityFederation` component in Pulumi.
- [ ] 0.2 Instantiate the component in `src/index.ts` for `dev` and `prod`.
- [ ] 0.3 Run `pulumi up` locally to provision WIF resources in both environments.

## 1. Configure Stack OIDC Settings (Pulumi Console)

- [ ] 1.1 In Pulumi Cloud, navigate to `dev` stack > Settings > Deploy.
- [ ] 1.2 Enable "Google Cloud Integration".
- [ ] 1.3 Enterprise GCP Project ID: `liverty-music-dev`.
- [ ] 1.4 Workload Identity Pool ID: `external-providers`.
- [ ] 1.5 Workload Identity Provider ID: `pulumi-provider`.
- [ ] 1.6 Service Account Email: `pulumi-cloud@liverty-music-dev.iam.gserviceaccount.com`.
- [ ] 1.7 Repeat steps 1.1–1.6 for the `prod` stack using `liverty-music-prod`.

## 2. Configure Git Source and Triggers

- [ ] 2.1 Set up GitHub repository as the source in the "Deploy" settings.
- [ ] 2.2 Enable "Managed Previews" (PR triggers).
- [ ] 2.3 Enable "Managed Updates" (Main branch merge triggers).

## 3. Verification

- [ ] 3.1 Trigger PR: Verify `dev` stack starts `up` and `prod` stack starts `preview`.
- [ ] 3.2 Verify `prod` preview results are commented in the PR.
- [ ] 3.3 Merge PR: Verify `prod` stack starts `up`.
- [ ] 3.4 Delete `.github/workflows/pulumi-*.yml`.
