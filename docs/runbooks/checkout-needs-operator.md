# Checkout needs an operator

Alert: **Checkout Needs Operator** (Cloud Monitoring, log-based on
`jsonPayload.msg="checkout needs an operator"` in namespace `backend`).

A first-come checkout (`checkouts` row) has money taken without its tickets.
The fan-api sweepers log it every minute, with `checkout_id` and
`card_authorization_id` (the payment provider's ID for the card authorization,
a Stripe PaymentIntent `pi_...`), until it is resolved. Two cases:

1. **Charged but not issued** (`status = 2` Committed, `capture_at` set more
   than 10 minutes ago). The card was charged, but issuing the Order keeps
   failing. The checkout is never charged again and never released.
2. **Charged card authorization on an ended checkout** (`status` 4 Expired or
   5 Released, the log says "the card authorization of an ended checkout was
   charged"). Releasing the card authorization failed because the payment
   provider had already captured it.

## 1. Read the checkout

Connect read-only (see `cloud-sql-access.md`) and run:

```sql
SET search_path TO app;
SELECT c.id, c.status, c.ticket_count, c.amount, c.commit_at, c.capture_at,
       c.card_authorization_id, tt.event_id, o.id AS order_id
FROM checkouts c
JOIN ticket_types tt ON tt.id = c.ticket_type_id
LEFT JOIN orders o ON o.checkout_id = c.id
WHERE c.id = '<checkout_id>';
```

Search Cloud Logging for `jsonPayload.checkout_id="<checkout_id>"` to see why
issuance fails (for example the event's series has no Organizer, or the
Organizer row is missing).

## 2a. Charged but not issued: fix the cause

Fix what makes issuance fail (the Organizer, the event's series). The next
sweep (within a minute) issues the Order, its Tickets and its Settlement
without charging again, and the fan receives the confirmation email. The
alert closes an hour after the last log line.

## 2b. When it cannot be issued: refund manually

When the purchase must not stand (for example the concert was cancelled),
refund it in the Stripe dashboard: open the PaymentIntent
`card_authorization_id`, refund the full amount, and note the checkout id in
the refund reason. No Order exists, so `OrderUseCase.Refund` cannot act on it.

There is no state yet for a refunded checkout that will never be issued: the
row stays Committed and charged by design, so the sweeper keeps retrying and
the alert keeps re-notifying hourly. Record the refund in a support ticket and
escalate to the backend team; this case is an open question of
first-come-ticket-sales.

## 2c. Charged card authorization on an ended checkout

The fan did not receive tickets for this charge. Refund the PaymentIntent
`card_authorization_id` in full in the Stripe dashboard. The checkout's
tickets were already returned to the sale.
