# Workflow needs an admin

Alert: **Workflow Needs Admin** (Cloud Monitoring, metric
`workload.googleapis.com/workflow.needs_admin` above 0, labels
`workflow_name` and `status`).

A durable workflow ended in a state that no retry will leave. The workflow
worker (Deployment `workflow-worker`, namespace `backend`) counts these every 5
minutes into the gauge and logs each one once. The alert stays open until the
gauge returns to 0, that is until every such workflow is resumed, forked or
deleted. Nothing deletes them on its own: the daily `delete-old-workflows`
schedule removes only workflows that ended successfully.

| `status` | What happened | Usual action |
|---|---|---|
| `ERROR` | A step failed with an error nobody planned for (not `Unavailable` or `DeadlineExceeded`, which are retried), or the workflow returned one. | Fix the cause, then `resume` |
| `MAX_RECOVERY_ATTEMPTS_EXCEEDED` | The worker stopped while running it more than 100 times, usually because the workflow crashes or overruns the worker's memory. | Fix the crash, then `resume` |
| `CANCELLED` | It passed the deadline its starter gave it, still retrying a step that stayed `Unavailable`. | Decide whether the work still matters: `resume` (it runs on without a deadline), `fork`, or handle by hand and `delete` |

## 1. Find the workflow ids

The worker logs each workflow once, at ERROR, with its id:

```
resource.type="k8s_container"
resource.labels.namespace_name="backend"
resource.labels.container_name="worker"
jsonPayload.msg="workflow needs an admin"
```

Each entry carries `workflow_id`, `workflow_name`, `status` and the error. A
worker that restarted logs the open ones again on its first report.

Or list them from the worker (get prod credentials first:
[prod-cluster-credentials.md](prod-cluster-credentials.md)):

```bash
kubectl exec deploy/workflow-worker -n backend -- \
  /worker workflow list -status ERROR,MAX_RECOVERY_ATTEMPTS_EXCEEDED,CANCELLED
```

The `workflow` subcommands run in the worker's Pod, as its database identity
(`fan-api`), the only role granted the workflow tables in schema `dbos`; the
personal read-only `db-proxy` login ([cloud-sql-access.md](cloud-sql-access.md))
cannot read them. Every subcommand prints JSON on stdout and logs on stderr.

## 2. Read its steps

```bash
kubectl exec deploy/workflow-worker -n backend -- /worker workflow steps <workflow_id>
```

Each step has its position (`function_id`), name, recorded output and error.
The last step with an error is where it stopped. Search Cloud Logging for
`jsonPayload.workflow_id="<workflow_id>"` and the trace of the run for the
full error.

## 3. Resolve it

Pick one. The gauge drops on the next report, within 5 minutes, and the alert
closes.

- **Resume**, once the cause is fixed (a missing row, a bad configuration, a
  deployed fix). The workflow runs again under the same id from its last
  completed step; completed steps are not repeated.

  ```bash
  kubectl exec deploy/workflow-worker -n backend -- /worker workflow resume <workflow_id>
  ```

- **Fork from a step**, when a completed step must run again (it recorded a
  wrong result). The fork is a new workflow with a new id that reuses the steps
  before `N` and runs from `N`; the original stays reported until you delete
  it.

  ```bash
  kubectl exec deploy/workflow-worker -n backend -- /worker workflow fork <workflow_id> -step <N>
  kubectl exec deploy/workflow-worker -n backend -- /worker workflow delete <workflow_id>
  ```

  A step that calls an external system uses an idempotency key named after
  the business operation (for example `refund:<order>`), so running it again
  does not repeat the effect at the provider.

- **Handle by hand and delete**, when the work must not complete (the concert
  was cancelled, the fan already got a refund). Do the business action first
  (for example in the Stripe dashboard), record it in the support ticket, then
  delete the workflow's record:

  ```bash
  kubectl exec deploy/workflow-worker -n backend -- /worker workflow delete <workflow_id>
  ```

## Background

OpenSpec change `introduce-durable-workflows` (capability
`components/infrastructure/backend/process/durable-workflows`). The workflow
rules for code are in `backend/AGENTS.md`, "Durable workflows".
