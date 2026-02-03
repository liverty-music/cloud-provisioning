## 1. Pulumi Infrastructure Updates

- [ ] 1.1 Add Workload Identity Federation (WIF) Pool and Provider to Pulumi GCP stack.
- [ ] 1.2 Create Service Account for CI/CD and bind to WIF subject (GitHub repo).
- [ ] 1.3 Configure Artifact Registry Writer permissions for the Service Account.
- [ ] 1.4 Apply Pulumi changes to provision authentication infrastructure.

## 2. Kubernetes Manifests

- [ ] 2.1 Create Kustomize base for `backend` application (Deployment, Service).
- [ ] 2.2 Configure `backend` specific ConfigMap/Secrets if required.
- [ ] 2.3 Integrate `backend` application into ArgoCD (update Root App or add App definition).

## 3. CI/CD Pipeline

- [ ] 3.1 Create GitHub Actions workflow (`.github/workflows/deploy.yaml`) in `backend` repository.
- [ ] 3.2 Configure workflow to authenticate via WIF (using provider defined in step 1).
- [ ] 3.3 Configure workflow to build and push container image to Google Artifact Registry.
- [ ] 3.4 Process a merge to `main` to trigger and verify the pipeline.

## 4. Verification

- [ ] 4.1 Verify ArgoCD successfully syncs the new `backend` application.
- [ ] 4.2 Verify the backend pods are running and healthy.
- [ ] 4.3 Validate internal connectivity to the backend service.
