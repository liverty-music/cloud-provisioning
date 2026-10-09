# Checkout needs an operator

Alert: **Checkout Needs Operator** (Cloud Monitoring, log-based on
`jsonPayload.msg="reservation needs an operator"` in namespace `backend`).

A first-come checkout (`reservations` row) has money taken without its tickets.
The fan-api sweepers log it every minute, with `reservation_id` and
`payment_ref` (the Stripe PaymentIntent), until it is resolved. Two cases:

1. **Charged but not issued** (`status = 2` Committed, `capture_at` set more
   than 10 minutes ago). The card was charged, but issuing the Order keeps
   failing. The checkout is never charged again and never released.
2. **Charged hold on an ended checkout** (`status` 4 Expired or 5 Released,
   the log says "the card hold of an ended checkout was charged"). Cancelling
   the card hold failed because Stripe already captured it.

## 1. Read the checkout

Connect read-only (see `cloud-sql-access.md`) and run:

```sql
SET search_path TO app;
SELECT r.id, r.status, r.ticket_count, r.amount, r.committed_at, r.capture_at,
       r.payment_ref, r.authorization_ref, ts.event_id, o.id AS order_id
FROM reservations r
JOIN ticket_sales ts ON ts.id = r.ticket_sale_id
LEFT JOIN orders o ON o.reservation_id = r.id
WHERE r.id = '<reservation_id>';
```

Search Cloud Logging for `jsonPayload.reservation_id="<reservation_id>"` to
see why issuance fails (for example the event's series has no Organizer, or
the Organizer row is missing).

## 2a. Charged but not issued: fix the cause

Fix what makes issuance fail (the Organizer, the event's series). The next
sweep (within a minute) issues the Order, its Tickets and its Settlement
without charging again, and the fan receives the confirmation email. The
alert closes an hour after the last log line.

## 2b. When it cannot be issued: refund manually

When the purchase must not stand (for example the concert was cancelled),
refund it in the Stripe dashboard: open the PaymentIntent `payment_ref`,
refund the full amount, and note the reservation id in the refund reason.
No Order exists, so `RefundOrder` cannot act on it.

There is no state yet for a refunded checkout that will never be issued: the
row stays Committed and charged by design, so the sweeper keeps retrying and
the alert keeps re-notifying hourly. Record the refund in a support ticket and
escalate to the backend team; this case is an open question of
first-come-ticket-sales.

## 2c. Charged hold on an ended checkout

The fan did not receive tickets for this charge. Refund the PaymentIntent
`payment_ref` in full in the Stripe dashboard. The checkout's tickets were
already returned to the sale.
