# CoachLinkBooking — payment setup

The website uses Safaricom Daraja STK Push. A booking is marked **PAID** only after the server receives a successful Safaricom callback and confirms that the callback amount matches the saved booking amount.

## Render environment variables

Open the CoachLinkBooking web service in Render → **Environment** and add:

| Variable | Value |
|---|---|
| `MPESA_ENV` | `sandbox` while testing; change to `production` only after Safaricom Go-Live approval |
| `MPESA_CONSUMER_KEY` | Your Daraja app consumer key (secret) |
| `MPESA_CONSUMER_SECRET` | Your Daraja app consumer secret (secret) |
| `MPESA_SHORTCODE` | The shortcode linked to your Daraja STK Push product |
| `MPESA_PASSKEY` | Your Daraja Lipa na M-Pesa Online passkey (secret) |
| `MPESA_TRANSACTION_TYPE` | The transaction type issued for your Paybill or Buy Goods account |
| `MPESA_CALLBACK_URL` | `https://YOUR-RENDER-DOMAIN/api/payments/callback` |
| `ROUTE_FARES_JSON` | JSON object of verified one-way fares per passenger |
| `SESSION_SECRET` | A long random secret used to sign login sessions and ticket QR data |

Do not commit Daraja keys, passkeys, or live credentials to GitHub or paste them into public code.

## Route fare format

Use lower-case route keys separated by a vertical bar. The amount is the one-way fare in Kenya shillings **per passenger**. Replace this example with your real routes and verified fares:

```json
{"towna|townb": 1000, "townb|towna": 1000}
```

Round trips are calculated as two one-way journeys. If a route has no configured fare, the server refuses the booking and does not request payment.

## Callback

Set the Daraja callback URL to:

```
https://YOUR-RENDER-DOMAIN/api/payments/callback
```

It must be publicly reachable over HTTPS. The server stores the checkout request ID, processes the callback, checks the amount against the booking, and records the M-Pesa receipt. A QR e-ticket is generated only after payment is confirmed.

## Safe launch sequence

1. Test with Daraja sandbox credentials and sandbox test phone numbers.
2. Confirm the callback reaches the deployed service and a paid booking gets a QR ticket.
3. Apply for Safaricom Daraja Go-Live and link your own authorised Paybill/Till.
4. Add production credentials in Render Environment and change `MPESA_ENV` to `production`.
5. Confirm the real route fares and test a low-value live transaction before opening bookings.

The website is an independent CoachLink service. It does not use ENA Coach merchant credentials or claim to be ENA Coach.
