# A purchase took money without issuing tickets

A first-come purchase can end with the card charged and no tickets issued, or
with an ended purchase whose card authorization could not be released. The
backend finishes each of them with a durable workflow, so both show up as a
workflow that needs an admin: the alert **Workflow Needs Admin**
([workflow-needs-admin.md](workflow-needs-admin.md)). This page is what to look
at for a purchase.

The alert **Checkout Needs Operator** (`jsonPayload.msg="checkout needs an
operator"`) comes from the time the fan-api sweepers finished purchases, one run
a minute. Those sweepers were removed on 2026-11-03 (backend `efd505e0`, "issue
a first-come checkout through the issue workflow"), and nothing in the backend
logs that message any more (only the constant `LogKeyNeedsOperator` is left), so
that alert does not fire. Do not wait for it.

Two cases, each one workflow per Order, named after the Order:

1. **Charged but not issued**: the workflow `issue:<order_id>` ended `ERROR`,
   `MAX_RECOVERY_ATTEMPTS_EXCEEDED` or `CANCELLED` (it stops trying after 24
   hours). The Order is Pending (`orders.status = 4`) and the Checkout is
   Committed (`checkouts.status = 2`), with `capture_time` set once the card was
   charged. Issue charges once, so a resumed run does not charge again.
2. **Releasing the card authorization of an ended purchase failed**: the
   workflow `release:<order_id>` ended `ERROR`. The Order is Void
   (`orders.status = 5`). A Checkout that was charged is never Expired or
   Released (`chk_checkouts_charged_never_ended`), so the usual cause is that
   the payment provider had already captured the card authorization on its own;
   the failed release step carries the provider's error, which says which it is.

## 1. Find the workflow and read the Order

Find the workflow ids as in [workflow-needs-admin.md](workflow-needs-admin.md),
section 1 (`workflow_name` is `issue` or `release-card-authorization`, and the
id ends with the Order id). Then connect read-only (see `cloud-sql-access.md`)
and read the Order:

```sql
SET search_path TO app;
SELECT o.id AS order_id, o.status AS order_status, o.amount, o.ticket_count,
       o.pay_time, c.id AS checkout_id, c.status AS checkout_status,
       c.commit_time, c.capture_time,
       ca.provider_card_authorization_id
FROM orders o
LEFT JOIN checkouts c ON c.order_id = o.id
LEFT JOIN card_authorizations ca ON ca.id = o.card_authorization_id
WHERE o.id = '<order_id>';
```

`provider_card_authorization_id` is the payment provider's ID for the card
authorization, a Stripe PaymentIntent `pi_...`. `orders.status` is 1 Paid,
2 Refunded, 4 Pending, 5 Void.

Read the steps of the workflow
(`/worker workflow steps <workflow_id>`, see workflow-needs-admin.md section 2)
and search Cloud Logging for `jsonPayload.workflow_id="<workflow_id>"` to see
why it stopped (for example the event's series has no Organizer, or the
Organizer row is missing).

## 2a. Charged but not issued: fix the cause, then resume

Fix what makes issuance fail (the Organizer, the event's series). Then resume
the workflow; it runs on from its last completed step without charging again,
issues the Order, its Tickets and its Settlement, and the fan receives the
confirmation email:

```bash
kubectl exec deploy/workflow-worker -n backend -- /worker workflow resume issue:<order_id>
```

The gauge drops on the next report, within 5 minutes, and the alert closes.

## 2b. When it cannot be issued: refund by hand

When the purchase must not stand (for example the concert was cancelled), refund
it in the Stripe dashboard: open the PaymentIntent
`provider_card_authorization_id`, refund the full amount, and note the order id
in the refund reason. The Order is Pending, so `OrderUseCase.Refund`, which acts
on a Paid Order, cannot do it. Record the refund in a support ticket, then
delete the workflow's record:

```bash
kubectl exec deploy/workflow-worker -n backend -- /worker workflow delete issue:<order_id>
```

The Order statuses (Paid, Refunded, Pending, Void) have no state for a Pending
Order that was refunded by hand, so the Order and its Checkout stay as they are.
Escalate it to the backend team with the ticket.

## 2c. Release of an ended purchase failed

The fan did not receive tickets for this charge. Read the error of the failed
`release` step (`/worker workflow steps release:<order_id>`); it says which of
two cases this is, and the PaymentIntent `provider_card_authorization_id` shows
the same in the Stripe dashboard:

- **The provider had already captured it** (the card was charged). Refund the
  PaymentIntent in full in the Stripe dashboard. The tickets were already
  returned to the sale.
- **It is still an uncaptured hold** (the release failed for another reason).
  A refund is not possible. Fix the cause and resume the release
  (`/worker workflow resume release:<order_id>`), or cancel the PaymentIntent in
  the Stripe dashboard, so the hold is gone from the fan's card.

Record it in the support ticket, then delete the workflow's record, only after
the money or the hold is gone:

```bash
kubectl exec deploy/workflow-worker -n backend -- /worker workflow delete release:<order_id>
```
