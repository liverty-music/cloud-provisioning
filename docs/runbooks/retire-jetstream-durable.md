# Retire a JetStream durable

Every Consumer manifest in `k8s/namespaces/nats/base/jetstream/` sets
`preventDelete: true`, so NACK never deletes a durable on its own. That keeps a
durable and its position when its manifest is renamed or briefly broken, but it
also means that removing a manifest leaves the durable on the server. It then
keeps every message of its subject until it is deleted.

This is a manual step because it happens once per retired durable (AGENTS.md,
"A manual step is right only in three cases").

## When

After the PR that removes the Consumer manifest and its KEDA trigger has
merged, and the backend that no longer consumes the subject is live in that
environment. Deleting a durable the running backend still binds makes the
event consumer report it unbound.

## What you need

- `kubectl` pointed at the cluster ([prod-cluster-credentials.md](prod-cluster-credentials.md) for prod).
- The NATS CLI, run through mise without installing it:
  `mise x aqua:nats-io/natscli@0.5.1 -- nats`. The examples below write it as `nats`.

## Steps

1. Forward the client port. Keep this terminal open.

   ```bash
   kubectl port-forward -n nats pod/nats-0 14222:4222
   ```

2. List the durables on the server that no manifest declares. A name printed
   here is a candidate; check that it is the one you retired.

   ```bash
   comm -13 \
     <(grep -h 'durableName:' k8s/namespaces/nats/base/jetstream/*.yaml | awk '{print $2}' | sort -u) \
     <(for s in $(nats -s nats://127.0.0.1:14222 stream ls --names); do
         nats -s nats://127.0.0.1:14222 consumer ls "$s" --names; done | sort -u)
   ```

3. Check that it holds nothing. Both values must be 0; otherwise find out why
   before deleting anything.

   ```bash
   nats -s nats://127.0.0.1:14222 consumer info <STREAM> <DURABLE> --json | jq '{num_pending, num_ack_pending}'
   ```

4. Delete it.

   ```bash
   nats -s nats://127.0.0.1:14222 consumer rm <STREAM> <DURABLE> -f
   ```

5. Run step 2 again: nothing is printed. An empty result also comes from a
   failed connection, so check that the server's list is not empty (the second
   half of step 2 piped to `wc -l` counts the durables on the server).

A name in a backend's code is not proof that the durable is in use: the DBOS
workflows reuse some of the old durable names (`notify-passkey-change`,
`deliver-notification`). What the event consumer binds is the route list in the
backend's `internal/di/consumer.go`.
