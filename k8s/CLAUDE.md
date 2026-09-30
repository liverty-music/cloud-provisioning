# Kubernetes manifests

### Kubernetes Manifest Dry-Run

Before committing any changes to `k8s/` manifests, run a Kustomize dry-run:

```bash
# Plain Kustomize overlays (no Helm)
kubectl kustomize k8s/<path>/overlays/<env>

# Helm-based overlays (ESO, Reloader, etc.)
kubectl kustomize --enable-helm k8s/<path>/overlays/<env>
```

Check `k8s/<path>/base/kustomization.yaml` for `helmCharts:` to determine if `--enable-helm` is needed.

Verify:
- All targeted resources render without errors
- Patches apply to the correct resources (name, nodeSelector, replicas)
- No unintended resources are modified

Do not commit if `kubectl kustomize` returns an error or patches are missing.

### Dev Cost Optimization

When creating or modifying Kubernetes workload manifests for `dev` environment:

- **Disable non-essential sidecars**: Debug tools (e.g., nats-box), test pods, and optional sidecars should be disabled in dev overlays unless actively needed.

- **Verify before commit**: In the Kustomize dry-run, also check that no container has empty `resources: {}`, all workloads have `gke-spot: "true"` nodeSelector, and no unnecessary Pods are rendered.
