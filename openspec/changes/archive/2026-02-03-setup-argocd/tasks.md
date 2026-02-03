# Tasks: Setup ArgoCD

- [x] **Define Kustomize Ecosystem**
  - [x] Create directory `k8s/namespaces/argocd/base`
  - [x] Create `k8s/namespaces/argocd/base/kustomization.yaml` (OCI Chart)
  - [x] Create `k8s/namespaces/argocd/overlays/dev` and `prod` directories

- [x] **Define Root Application (App of Apps)**
  - [x] Create `k8s/argocd-apps/dev` structure
  - [x] Create `k8s/namespaces/argocd/base/root-app.yaml` pointing to `argocd-apps/dev`
  - [x] Define `Application` targeting `https://github.com/liverty-music/cloud-provisioning.git`
  - [x] Configure applications (`argocd.yaml`, `cluster.yaml`) in `argocd-apps/dev`

- [x] **Manual Bootstrap**
  - [x] Apply Namespace: `kubectl apply -f k8s/cluster/namespaces.yaml`
  - [x] Apply ArgoCD Manifests: `kubectl kustomize --enable-helm k8s/namespaces/argocd/overlays/dev | kubectl apply --server-side --force-conflicts -f -`
  - [x] Apply Root Application: `kubectl apply -f k8s/namespaces/argocd/base/root-app.yaml`

- [x] **Documentation**
  - [x] Add `k8s/namespaces/argocd/README.md`
