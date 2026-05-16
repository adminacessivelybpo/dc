require("dotenv").config();

const express = require("express");
const { config } = require("./config");
const {
  startDiscordClient,
  sendDeliveryDM,
  postBuyPanel,
  postStockPanel,
  refreshLiveStockSummary,
  sendChannelMessage
} = require("./discord");
const { getMeta, setMeta } = require("./store");
const { verifyPayPalWebhook } = require("./payments/paypal");
const {
  createOrder,
  getOrder,
  listOrders,
  importInventory,
  getInventorySummary,
  markPaymentAndAutoFulfill,
  manualFulfillOrder,
  submitPaymentProof
} = require("./services/orderService");

const app = express();

const defaultCatalog = [
  { sku: "rdp-basic", label: "RDP Basic", price: 10, currency: "USD" },
  { sku: "rdp-pro", label: "RDP Pro", price: 20, currency: "USD" }
];

function parseJsonOrFallback(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Invalid JSON config, using fallback: ${error.message}`);
    return fallback;
  }
}

const catalog = parseJsonOrFallback(config.catalogJson, defaultCatalog);
const paymentMethodInstructions = parseJsonOrFallback(config.paymentMethodInstructionsJson, {
  paypal: "Send payment to your PayPal checkout link and keep your transaction ID.",
  gcash: "Send payment to your GCash number and keep your reference number."
});

let adIntervalTimer = null;

function buildAdText() {
  const mention = config.autoAdMentionRoleId ? `<@&${config.autoAdMentionRoleId}>\n` : "";
  return `${mention}${config.autoAdMessage}`;
}

async function postAutoAdNow() {
  const channelIds = [...(config.autoAdChannelIds || [])];
  if (!channelIds.length && config.autoAdChannelId) {
    channelIds.push(config.autoAdChannelId);
  }

  if (!channelIds.length) {
    throw new Error("AUTO_AD_CHANNEL_ID or AUTO_AD_CHANNEL_IDS is not configured");
  }

  const content = buildAdText();
  const results = await Promise.allSettled(channelIds.map((id) => sendChannelMessage(id, content)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    throw new Error(`Ad posted to ${channelIds.length - failed.length}/${channelIds.length} channels`);
  }
}

function startAutoAdScheduler() {
  if (!config.autoAdEnabled) {
    return;
  }

  const intervalMs = config.autoAdIntervalMinutes * 60 * 1000;
  adIntervalTimer = setInterval(() => {
    postAutoAdNow().catch((error) => {
      console.warn(`Auto ad skipped: ${error.message}`);
    });
  }, intervalMs);

  console.log(
    `Auto ad scheduler enabled: channels=${
      (config.autoAdChannelIds && config.autoAdChannelIds.length) || (config.autoAdChannelId ? 1 : 0)
    } every ${config.autoAdIntervalMinutes} minute(s)`
  );
}

app.use(
  express.json({
    verify(req, _res, buf) {
      req.rawBody = buf.toString("utf8");
    }
  })
);

function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function renderDeliveryMessage(order) {
  const d = order.delivery;
  return [
    `Your order ${order.orderRef || order.id} is ready.`,
    `Host: ${d.host}`,
    `Port: ${d.port}`,
    `Username: ${d.username}`,
    `Password: ${d.password}`,
    d.note ? `Note: ${d.note}` : null,
    "Keep these credentials private."
  ]
    .filter(Boolean)
    .join("\n");
}

async function notifyIfDelivered(order) {
  if (order.status !== "fulfilled" || !order.delivery) return;
  const msg = renderDeliveryMessage(order);
  await sendDeliveryDM(order.discordUserId, msg);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/orders", (req, res) => {
  const { discordUserId, sku, price, currency, paymentMethod } = req.body;
  if (!discordUserId || !sku || !price || !currency) {
    return res.status(400).json({ error: "discordUserId, sku, price, currency are required" });
  }

  const order = createOrder({
    discordUserId: String(discordUserId),
    sku: String(sku),
    price: Number(price),
    currency: String(currency).toUpperCase(),
    paymentMethod: paymentMethod ? String(paymentMethod).toLowerCase() : null
  });

  return res.status(201).json({ order });
});

app.get("/orders/:orderId", requireAdmin, (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Not found" });
  }
  return res.json({ order });
});

app.get("/admin/orders", requireAdmin, (req, res) => {
  const limit = Number(req.query.limit || 50);
  const orders = listOrders(limit).map((o) => ({
    id: o.id,
    orderRef: o.orderRef,
    sku: o.sku,
    status: o.status,
    price: o.price,
    currency: o.currency,
    discordUserId: o.discordUserId,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  }));
  return res.json({ count: orders.length, orders });
});

app.post("/admin/inventory", requireAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items[] is required" });
  }

  const count = importInventory(items);
  return res.json({ imported: count });
});

app.get("/admin/inventory/summary", requireAdmin, (_req, res) => {
  const summary = getInventorySummary();
  return res.json({ summary });
});

app.post("/admin/manual-fulfill", requireAdmin, async (req, res) => {
  try {
    const { orderId, orderRef, host, port, username, password, note } = req.body;
    const orderLookup = orderRef || orderId;
    if (!orderLookup || !host || !username || !password) {
      return res.status(400).json({ error: "orderId/orderRef, host, username, password are required" });
    }

    const existing = getOrder(orderLookup);
    if (!existing) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = manualFulfillOrder({
      orderId: existing.id,
      host,
      port: Number(port || 3389),
      username,
      password,
      note
    });

    await notifyIfDelivered(order);
    return res.json({ order });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/admin/post-buy-panel", requireAdmin, async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      return res.status(400).json({ error: "channelId is required" });
    }

    await postBuyPanel(channelId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/admin/post-stock-panel", requireAdmin, async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      return res.status(400).json({ error: "channelId is required" });
    }

    await postStockPanel(channelId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/admin/live-stock/refresh", requireAdmin, async (_req, res) => {
  try {
    await refreshLiveStockSummary();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/admin/ads/post-now", requireAdmin, async (_req, res) => {
  try {
    await postAutoAdNow();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/webhooks/paypal", async (req, res) => {
  try {
    const valid = await verifyPayPalWebhook(req.headers, req.body);
    if (!valid) {
      return res.status(400).json({ error: "Invalid PayPal signature" });
    }

    const event = req.body;
    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
      return res.json({ ok: true, ignored: true });
    }

    const customOrderId = event.resource?.custom_id;
    const amount = event.resource?.amount?.value;
    const currency = event.resource?.amount?.currency_code;
    const paymentId = event.resource?.id;

    if (!customOrderId || !amount || !currency || !paymentId) {
      return res.status(400).json({ error: "Incomplete PayPal capture payload" });
    }

    const result = markPaymentAndAutoFulfill({
      orderId: customOrderId,
      provider: "paypal",
      providerPaymentId: paymentId,
      paidAmount: Number(amount),
      currency,
      eventId: event.id
    });

    if (result.order?.status === "fulfilled") {
      await notifyIfDelivered(result.order);
    }

    return res.json({ ok: true, idempotent: result.idempotent });
  } catch (error) {
    console.error("PayPal webhook error:", error);
    return res.status(400).json({ error: error.message });
  }
});

app.post("/webhooks/gcash", (req, res) => {
  try {
    if (!config.GCASH_WEBHOOK_SECRET) {
      return res.status(500).json({ error: "GCASH_WEBHOOK_SECRET not configured" });
    }

    const secret = req.headers["x-gcash-secret"];
    if (secret !== config.GCASH_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { eventId, orderId, paymentId, amount, currency } = req.body;
    const result = markPaymentAndAutoFulfill({
      orderId,
      provider: "gcash",
      providerPaymentId: paymentId,
      paidAmount: Number(amount),
      currency: String(currency).toUpperCase(),
      eventId
    });

    if (result.order?.status === "fulfilled") {
      notifyIfDelivered(result.order).catch((err) => console.error("Discord notify failed:", err));
    }

    return res.json({ ok: true, idempotent: result.idempotent });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

(async function main() {
  const getLiveStockBoardMap = () => getMeta("liveStockBoardMessageIds", {});
  const setLiveStockBoardMap = (nextMap) => setMeta("liveStockBoardMessageIds", nextMap);

  await startDiscordClient(config.DISCORD_BOT_TOKEN, {
    addStockItems(items) {
      return importInventory(items);
    },
    getInventorySummary() {
      return getInventorySummary();
    },
    getLiveStockMessageId(channelId) {
      const map = getLiveStockBoardMap();
      return map[channelId] || null;
    },
    setLiveStockMessageId(channelId, messageId) {
      const map = getLiveStockBoardMap();
      map[channelId] = messageId;
      return setLiveStockBoardMap(map);
    },
    liveStockChannelId: config.liveStockChannelId,
    staffLogChannelId: config.STAFF_LOG_CHANNEL_ID,
    getPaymentInstructions(paymentMethod) {
      const key = String(paymentMethod || "").toLowerCase();
      return paymentMethodInstructions[key] || "Contact staff for payment instructions.";
    },
    createOrderFromSelection({ discordUserId, sku, paymentMethod }) {
      const selected = catalog.find((item) => item.sku === sku);
      if (!selected) {
        throw new Error("Invalid SKU. Ask admin to update product catalog.");
      }

      return createOrder({
        discordUserId,
        sku: selected.sku,
        price: Number(selected.price),
        currency: String(selected.currency || "USD").toUpperCase(),
        paymentMethod: paymentMethod || null
      });
    },
    async submitPaymentProof({ orderId, discordUserId, paymentRef }) {
      const order = getOrder(orderId);
      if (!order) {
        throw new Error("Order not found");
      }

      if (String(order.discordUserId) !== String(discordUserId)) {
        throw new Error("This order does not belong to you");
      }

      const updatedOrder = submitPaymentProof({
        orderId,
        paymentMethod: order.checkoutPaymentMethod || order.paymentProof?.paymentMethod || "manual",
        paymentRef,
        submittedBy: discordUserId
      });

      if (!config.autoFulfillOnProof) {
        return { order: updatedOrder };
      }

      const paymentResult = markPaymentAndAutoFulfill({
        orderId,
        provider: "manual-proof",
        providerPaymentId: paymentRef,
        paidAmount: Number(order.price),
        currency: order.currency,
        eventId: `proof_${orderId}_${paymentRef}`
      });

      if (paymentResult.order?.status === "fulfilled") {
        await notifyIfDelivered(paymentResult.order);
      }

      return { order: paymentResult.order || updatedOrder };
    }
  });
  app.listen(config.port, () => {
    console.log(`Server listening on http://0.0.0.0:${config.port}`);
  });

  if (config.autoAdEnabled) {
    postAutoAdNow().catch((error) => {
      console.warn(`Initial auto ad skipped: ${error.message}`);
    });
  }
  startAutoAdScheduler();
})().catch((error) => {
  if (adIntervalTimer) {
    clearInterval(adIntervalTimer);
  }
  console.error(error);
  process.exit(1);
});
