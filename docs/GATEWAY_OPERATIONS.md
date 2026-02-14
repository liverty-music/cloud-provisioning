# Gateway Operations Runbook

This document provides operational procedures for managing the GKE Gateway API infrastructure that exposes the backend API at `api.dev.liverty-music.app`.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    DNS Resolution                                │
│  api.dev.liverty-music.app → <STATIC_IP> (Cloud DNS)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               GKE Gateway (Global External ALB)                  │
│  - TLS Termination (Certificate Manager)                        │
│  - HTTP→HTTPS Redirect (HSTS preloaded for .app domains)       │
│  - Cross-namespace routing (gateway ns → backend ns)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    HTTPRoute (gateway ns)                        │
│  - Routes: api.dev.liverty-music.app → backend/server:8080     │
│  - Policies: HealthCheck (gRPC), Backend (logging, timeout)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Backend Service (backend ns)                     │
│  - Connect-RPC server with CORS middleware                       │
│  - Health check: grpc.health.v1.Health/Check                    │
│  - Port: 8080 (h2c)                                             │
└─────────────────────────────────────────────────────────────────┘
```

## Components

- **Gateway**: Global External Application Load Balancer (namespace: `gateway`)
- **HTTPRoute**: Routes traffic to backend Service (namespace: `gateway`)
- **Policies**: HealthCheckPolicy, GCPBackendPolicy, GCPGatewayPolicy
- **Certificate**: Google-managed TLS certificate via Certificate Manager
- **Backend**: Connect-RPC server (namespace: `backend`)

## Daily Operations

### Checking Gateway Status

```bash
# Verify Gateway is ready
kubectl get gateway external-gateway -n gateway

# Expected output:
# NAME               CLASS                             ADDRESS        PROGRAMMED   AGE
# external-gateway   gke-l7-global-external-managed   <STATIC_IP>    True         Xd
```

### Checking HTTPRoute Status

```bash
# Verify HTTPRoute is accepted
kubectl get httproute -n gateway

# Get detailed status
kubectl describe httproute api-route -n gateway
```

### Viewing Backend Logs

```bash
# Stream backend logs
kubectl logs -n backend -l app=server -f

# Check for CORS warnings
kubectl logs -n backend -l app=server | grep -i cors
```

### Monitoring Health Checks

```bash
# View HealthCheckPolicy status
kubectl get healthcheckpolicy -n backend

# View backend pod health
kubectl get pods -n backend -o wide
```

## Certificate Management

### Certificate Status

```bash
# Check certificate status via gcloud
gcloud certificate-manager certificates describe api-cert \
  --format="table(name,state,managed.domains)"

# Expected state: ACTIVE
```

### Certificate Renewal

Google-managed certificates renew automatically 30 days before expiration. No manual action required.

**If certificate shows errors:**

1. Check DNS Authorization:
   ```bash
   gcloud certificate-manager dns-authorizations describe api-dns-auth
   ```

2. Verify CNAME record in Cloud DNS:
   ```bash
   gcloud dns record-sets list --zone=dev-liverty-music-zone | grep _acme-challenge
   ```

3. If CNAME is missing, retrieve it from DNS Authorization and add to Cloud DNS:
   ```bash
   # Get CNAME from DNS Authorization output
   gcloud certificate-manager dns-authorizations describe api-dns-auth

   # Add to Cloud DNS
   gcloud dns record-sets create <CNAME_NAME> \
     --zone=dev-liverty-music-zone \
     --type=CNAME \
     --ttl=300 \
     --rrdatas=<CNAME_VALUE>
   ```

### Updating Certificate Domains

To add new domains (e.g., `api2.dev.liverty-music.app`):

1. Create new DNS Authorization:
   ```bash
   gcloud certificate-manager dns-authorizations create api2-dns-auth \
     --domain="api2.dev.liverty-music.app"
   ```

2. Add CNAME record to Cloud DNS (see output from step 1)

3. Create new certificate or update existing:
   ```bash
   gcloud certificate-manager certificates create api2-cert \
     --domains="api2.dev.liverty-music.app" \
     --dns-authorizations="api2-dns-auth"
   ```

4. Add entry to Certificate Map:
   ```bash
   gcloud certificate-manager maps entries create api2-entry \
     --map="api-cert-map" \
     --certificates="api2-cert" \
     --hostname="api2.dev.liverty-music.app"
   ```

5. Update HTTPRoute to include new hostname in `spec.hostnames`

## Troubleshooting

### 502 Bad Gateway

**Symptom:** External requests return 502 error

**Diagnosis:**
```bash
# 1. Check backend pod status
kubectl get pods -n backend

# 2. Check health check status
kubectl get healthcheckpolicy -n backend -o yaml

# 3. Verify service endpoints
kubectl get endpoints server -n backend
```

**Common Causes:**
- Backend pods not ready (health checks failing)
- Service selector mismatch
- Health check config incorrect (wrong port or protocol)

**Fix:**
1. Ensure backend pods are Running and Ready (1/1)
2. Verify health check passes: `grpcurl -plaintext api.dev.liverty-music.app:8080 grpc.health.v1.Health/Check`
3. Check HealthCheckPolicy `port: 8080` and `type: GRPC` are correct

### CORS Errors from Browser

**Symptom:** Browser console shows CORS policy error

**Diagnosis:**
```bash
# 1. Test CORS preflight
curl -X OPTIONS https://api.dev.liverty-music.app/your.service.v1.YourService/Method \
  -H "Origin: https://liverty-music.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  -v

# Expected: HTTP/2 200 with access-control-allow-origin header
```

**Common Causes:**
- CORS_ALLOWED_ORIGINS env var not set or incorrect
- Origin not in allowed list
- CORS middleware not registered

**Fix:**
1. Check ConfigMap: `kubectl get configmap server-config -n backend -o yaml`
2. Verify CORS_ALLOWED_ORIGINS includes the requesting origin
3. Update ConfigMap if needed, restart pods: `kubectl rollout restart deployment/server-app -n backend`

### Certificate Not Active

**Symptom:** Certificate status is PROVISIONING or FAILED

**Diagnosis:**
```bash
# Check certificate state
gcloud certificate-manager certificates describe api-cert

# Check DNS Authorization
gcloud certificate-manager dns-authorizations describe api-dns-auth
```

**Common Causes:**
- CNAME record not added to DNS
- CNAME record incorrect value
- DNS propagation not complete

**Fix:**
1. Retrieve correct CNAME from DNS Authorization
2. Verify CNAME in Cloud DNS matches exactly
3. Wait 5-30 minutes for DNS propagation
4. Certificate Manager will auto-provision once DNS validates

### Gateway Not Getting IP Address

**Symptom:** `kubectl get gateway` shows ADDRESS as empty or pending

**Diagnosis:**
```bash
# Check Gateway events
kubectl describe gateway external-gateway -n gateway

# Check for GCP provisioning errors
kubectl get gateways -n gateway -o yaml
```

**Common Causes:**
- Static IP not reserved
- Certificate Map not created
- Insufficient IAM permissions

**Fix:**
1. Verify static IP exists: `gcloud compute addresses describe api-static-ip --global`
2. Verify Certificate Map exists: `gcloud certificate-manager maps describe api-cert-map`
3. Check Gateway annotations include `networking.gke.io/certmap: "api-cert-map"`
4. Wait 2-5 minutes for GCP to provision ALB

### High Latency

**Symptom:** API responses are slow (>500ms)

**Diagnosis:**
```bash
# 1. Check backend pod resources
kubectl top pods -n backend

# 2. Check backend logs for slow queries
kubectl logs -n backend -l app=server | grep -E "duration|latency"

# 3. Review GCP Load Balancer metrics
# Navigate to: GCP Console → Network Services → Load Balancing → <ALB> → Monitoring
```

**Common Causes:**
- Backend pod CPU/memory throttled
- Database query performance issues
- Network latency (ALB → GKE → Pod)

**Fix:**
1. Increase pod resources in `k8s/namespaces/backend/overlays/dev/kustomization.yaml`:
   ```yaml
   resources:
     requests:
       cpu: 200m      # Increase from 100m
       memory: 512Mi  # Increase from 256Mi
   ```
2. Scale replicas: `kubectl scale deployment server-app -n backend --replicas=2`
3. Investigate slow database queries (check Cloud SQL Query Insights)

## Configuration Updates

### Adding New CORS Origin

1. Update ConfigMap source:
   ```bash
   # File: k8s/namespaces/backend/overlays/dev/server/configmap.env
   CORS_ALLOWED_ORIGINS=https://liverty-music.app,http://localhost:5173,https://new-origin.app
   ```

2. Commit to git and let ArgoCD sync, or apply directly:
   ```bash
   kubectl create configmap server-config \
     --from-env-file=k8s/namespaces/backend/overlays/dev/server/configmap.env \
     -n backend \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. Restart backend pods:
   ```bash
   kubectl rollout restart deployment/server-app -n backend
   ```

### Scaling Backend

**Dev Environment (1 replica):**
```bash
kubectl scale deployment server-app -n backend --replicas=1
```

**Production (3 replicas for HA):**
```bash
kubectl scale deployment server-app -n backend --replicas=3
```

Update Kustomize overlay to persist change:
```yaml
# k8s/namespaces/backend/overlays/dev/kustomization.yaml
patches:
- patch: |-
    - op: replace
      path: /spec/replicas
      value: 3
  target:
    kind: Deployment
    name: server-app
```

### Updating Backend Timeout

1. Edit GCPBackendPolicy:
   ```bash
   kubectl edit gcpbackendpolicy backend-policy -n backend
   ```

2. Update `spec.default.timeoutSec` (default: 30):
   ```yaml
   spec:
     default:
       timeoutSec: 60  # Increase to 60 seconds
   ```

3. Persist in `k8s/namespaces/backend/base/policies/backend-policy.yaml`

## Cost Monitoring

### Current Dev Environment Cost Estimate

| Resource | Monthly Cost (USD) |
|----------|-------------------|
| Cloud SQL (PostgreSQL) | $60 |
| Global External ALB | $18 |
| GKE Compute (1 pod, 100m CPU, 256Mi RAM) | $3 |
| Static IP + DNS | $0.20 |
| **Total** | **~$81/month** |

### Monitoring Costs

1. GCP Console → Billing → Reports
2. Filter by:
   - Service: "Cloud Load Balancing"
   - Service: "Compute Engine" (for GKE nodes)
   - Service: "Cloud SQL"

3. Set budget alerts:
   ```bash
   # Via GCP Console → Billing → Budgets & Alerts
   # Set threshold: $100/month for dev environment
   ```

### Cost Optimization Tips

- **Dev environment**: Use 1 replica, minimal resources
- **Avoid over-provisioning**: Start with `requests: cpu: 100m, memory: 256Mi`
- **Monitor actual usage**: Check `kubectl top pods -n backend` regularly
- **Delete unused resources**: Remove test Gateways, unused certificates
- **Use Cloud SQL Proxy**: Reduce cross-zone data transfer costs

## Emergency Procedures

### Rollback to Previous Version

**If new deployment causes issues:**

1. Check ArgoCD sync history:
   ```bash
   kubectl get applications -n argocd
   ```

2. Rollback via ArgoCD UI:
   - Navigate to ArgoCD UI → backend-app → History
   - Select previous successful sync
   - Click "Rollback"

3. Or rollback via kubectl:
   ```bash
   kubectl rollout undo deployment/server-app -n backend
   ```

### Disable Gateway (Emergency)

**If Gateway is causing critical issues:**

```bash
# Pause Gateway reconciliation
kubectl annotate gateway external-gateway -n gateway argocd.argoproj.io/sync-options=Prune=false

# Delete Gateway (stops all external traffic)
kubectl delete gateway external-gateway -n gateway

# Re-create when ready
kubectl apply -f k8s/namespaces/gateway/base/gateway.yaml
```

### Incident Response Checklist

1. **Assess impact**: Is the API completely down or just degraded?
2. **Check backend health**: `kubectl get pods -n backend`
3. **Check Gateway status**: `kubectl get gateway -n gateway`
4. **Review logs**: `kubectl logs -n backend -l app=server --tail=100`
5. **Check GCP Console**: Network Services → Load Balancing → Monitoring
6. **Rollback if needed**: Use ArgoCD or kubectl rollout undo
7. **Document incident**: Create post-mortem with root cause and prevention steps

## Useful Commands Reference

```bash
# Gateway status
kubectl get gateway -n gateway -o wide

# HTTPRoute status
kubectl get httproute -n gateway -o yaml

# Backend pod status
kubectl get pods -n backend -o wide

# Stream backend logs
kubectl logs -n backend -l app=server -f

# Test health check
grpcurl -plaintext localhost:8080 grpc.health.v1.Health/Check

# Test API from external
curl -X POST https://api.dev.liverty-music.app/your.service.v1.YourService/Method \
  -H "Content-Type: application/json" \
  -d '{"field":"value"}'

# Test CORS preflight
curl -X OPTIONS https://api.dev.liverty-music.app/your.service.v1.YourService/Method \
  -H "Origin: https://liverty-music.app" \
  -H "Access-Control-Request-Method: POST" \
  -v

# Check certificate status
gcloud certificate-manager certificates describe api-cert

# Check static IP
gcloud compute addresses describe api-static-ip --global

# Check DNS records
gcloud dns record-sets list --zone=dev-liverty-music-zone

# ArgoCD sync
kubectl get applications -n argocd
kubectl describe application backend -n argocd
```

## Monitoring & Alerts

### GCP Monitoring Dashboards

1. **Load Balancer Metrics**:
   - GCP Console → Network Services → Load Balancing → <ALB>
   - Metrics: Request count, Latency, Error rate, Backend health

2. **Cloud SQL Metrics**:
   - GCP Console → SQL → <instance> → Monitoring
   - Metrics: CPU, Memory, Connections, Query insights

3. **GKE Workload Metrics**:
   - GCP Console → Kubernetes Engine → Workloads → backend
   - Metrics: Pod CPU, Memory, Restarts

### Recommended Alerts

1. **Gateway Unhealthy**:
   - Metric: `loadbalancing.googleapis.com/https/backend_request_count`
   - Condition: Error rate > 5%
   - Action: Check backend pod health

2. **Certificate Expiring**:
   - Metric: Certificate Manager certificate expiry
   - Condition: < 30 days to expiry
   - Action: Verify auto-renewal is working

3. **Backend Pod Crash Loop**:
   - Metric: Pod restart count
   - Condition: > 3 restarts in 10 minutes
   - Action: Check logs, rollback if needed

4. **High Latency**:
   - Metric: ALB backend latency
   - Condition: p99 > 1000ms
   - Action: Scale pods, investigate slow queries

## Additional Resources

- [GKE Gateway API Documentation](https://cloud.google.com/kubernetes-engine/docs/concepts/gateway-api)
- [Certificate Manager Documentation](https://cloud.google.com/certificate-manager/docs)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [Connect-RPC CORS Documentation](https://connectrpc.com/docs/go/cors)
