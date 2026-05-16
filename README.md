# Discord Auto Store Backend

This project is a backend service for a Discord-based digital store.

It supports:
- Order creation
- Payment confirmation via webhook (PayPal and GCash-style shared-secret webhook)
- Auto-fulfillment from preloaded inventory
- Manual fulfillment by pasting credentials once, then auto-DM to buyer
- Buy channel panel with buttons (`Buy Now`, `I Paid`)

## 1. Requirements

- Ubuntu server (you already have this)
- Node.js 20+
- Discord bot token
- PayPal developer app (optional but recommended for full auto-payment)

## 2. Install

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
PORT=3000
ADMIN_API_KEY=your-strong-admin-key
DISCORD_BOT_TOKEN=your-discord-bot-token
STAFF_LOG_CHANNEL_ID=discord-channel-id-for-staff-logs

# Discord Buy panel catalog and payment instructions (JSON format)
CATALOG_JSON=[{"sku":"rdp-basic","label":"RDP Basic","price":10,"currency":"USD"},{"sku":"rdp-pro","label":"RDP Pro","price":20,"currency":"USD"}]
PAYMENT_METHOD_INSTRUCTIONS_JSON={"paypal":"Pay to your PayPal checkout link.","gcash":"Pay to your GCash number and keep the reference."}
AUTO_FULFILL_ON_PROOF=false

# Auto advertisement in buy/sell channel
AUTO_AD_ENABLED=false
AUTO_AD_CHANNEL_ID=your-buy-sell-channel-id
AUTO_AD_INTERVAL_MINUTES=60
AUTO_AD_MESSAGE=RDP STOCK AVAILABLE. DM OR CLICK BUY PANEL TO ORDER.
AUTO_AD_MENTION_ROLE_ID=

PAYPAL_CLIENT_ID=your-paypal-client-id
PAYPAL_CLIENT_SECRET=your-paypal-client-secret
PAYPAL_WEBHOOK_ID=your-paypal-webhook-id
PAYPAL_MODE=sandbox

GCASH_WEBHOOK_SECRET=your-gcash-shared-secret
```

## 3. Run

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

## 4. Basic API Flow

### Post Buy panel in your `#buy` channel

```bash
curl -X POST http://localhost:3000/admin/post-buy-panel \
	-H "Content-Type: application/json" \
	-H "x-admin-key: your-strong-admin-key" \
	-d '{
		"channelId": "123456789012345678"
	}'
```

What happens for buyers:
- Click **Buy Now**
- Enter SKU + payment method
- Bot creates order and shows payment instructions
- After payment, buyer clicks **I Paid** and sends order ID + payment reference
- Order goes to `awaiting_payment_review` (or auto-fulfills if `AUTO_FULFILL_ON_PROOF=true`)

### Post Staff Stock panel in staff-only channel

```bash
curl -X POST http://localhost:3000/admin/post-stock-panel \
	-H "Content-Type: application/json" \
	-H "x-admin-key: your-strong-admin-key" \
	-d '{
		"channelId": "123456789012345678"
	}'
```

What happens for staff:
- Click **Add Stock** button in staff channel
- Fill modal fields (`SKU`, `Label`, `Host:Port`, `Username`, `Password`)
- Bot writes item into inventory immediately

### Auto advertisement in buy/sell channel

Set in `.env`:
- `AUTO_AD_ENABLED=true`
- `AUTO_AD_CHANNEL_ID=<single_channel_id>` or `AUTO_AD_CHANNEL_IDS=<id1,id2,id3>`
- `AUTO_AD_INTERVAL_MINUTES=60` (minimum 5)
- `AUTO_AD_MESSAGE=your ad text`

For multiple Discord servers, invite the bot to each server and include each target channel ID in `AUTO_AD_CHANNEL_IDS`.

Manual trigger anytime:

```bash
curl -X POST http://localhost:3000/admin/ads/post-now \
	-H "x-admin-key: your-strong-admin-key"
```

### Create an order

```bash
curl -X POST http://localhost:3000/orders \
	-H "Content-Type: application/json" \
	-d '{
		"discordUserId": "123456789012345678",
		"sku": "rdp-basic",
		"price": 10,
		"currency": "USD"
	}'
```

Save the returned `order.id`.

### Import inventory (automatic stock delivery)

```bash
curl -X POST http://localhost:3000/admin/inventory \
	-H "Content-Type: application/json" \
	-H "x-admin-key: your-strong-admin-key" \
	-d '{
		"items": [
			{
				"sku": "rdp-basic",
				"label": "RDP #001",
				"host": "1.2.3.4",
				"port": 3389,
				"username": "Administrator",
				"password": "Pass123!"
			}
		]
	}'
```

### Manual fulfill (your requested workflow)

When the user has paid, paste credentials one time:

```bash
curl -X POST http://localhost:3000/admin/manual-fulfill \
	-H "Content-Type: application/json" \
	-H "x-admin-key: your-strong-admin-key" \
	-d '{
		"orderId": "ord_xxxxxxxxxxxxxxxx",
		"host": "5.6.7.8",
		"port": 3389,
		"username": "Administrator",
		"password": "StrongPass!",
		"note": "Valid for 30 days"
	}'
```

The bot will DM the buyer automatically.

### PayPal webhook (fully automatic)

Configure PayPal webhook URL:

```text
https://your-domain.com/webhooks/paypal
```

Use PayPal `custom_id` as your internal `order.id`, so when `PAYMENT.CAPTURE.COMPLETED` arrives, the order is auto-fulfilled.

### GCash webhook (through your own gateway)

```bash
curl -X POST http://localhost:3000/webhooks/gcash \
	-H "Content-Type: application/json" \
	-H "x-gcash-secret: your-gcash-shared-secret" \
	-d '{
		"eventId": "evt_gcash_001",
		"orderId": "ord_xxxxxxxxxxxxxxxx",
		"paymentId": "gcash_txn_123",
		"amount": 10,
		"currency": "USD"
	}'
```

## 5. UpCloud automation options

You have two valid paths:

1. Manual provisioning in UpCloud, then call `/admin/manual-fulfill`.
2. Full automation by adding an UpCloud API worker that creates VM, waits for readiness, sets password, then fulfills order.

This repo is already ready for path 1 and easy to extend for path 2.

## 6. Security checklist

- Never deliver from frontend success pages
- Always verify webhook signatures server-side
- Keep `.env` secret and rotate keys regularly
- Restrict who can call admin endpoints
- Log all fulfillments and refunds
