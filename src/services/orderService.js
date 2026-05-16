const crypto = require("crypto");
const { withStore } = require("../store");

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function toSkuRefPrefix(sku) {
  return String(sku || "item")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function buildOrderRef(sku, existingOrders) {
  const prefix = toSkuRefPrefix(sku) || "ITEM";
  const countForSku = existingOrders.filter((o) => toSkuRefPrefix(o.sku) === prefix).length;
  const seq = String(countForSku + 1).padStart(4, "0");
  return `${prefix}-${seq}`;
}

function createOrder({ discordUserId, sku, price, currency, paymentMethod }) {
  return withStore((store) => {
    const order = {
      id: randomId("ord"),
      orderRef: buildOrderRef(sku, store.orders),
      discordUserId,
      sku,
      price,
      currency,
      checkoutPaymentMethod: paymentMethod || null,
      status: "pending",
      payment: null,
      delivery: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    store.orders.push(order);
    return order;
  });
}

function getOrder(orderRefOrId) {
  return withStore((store) => {
    const q = String(orderRefOrId || "").toLowerCase();
    return (
      store.orders.find(
        (o) => String(o.id || "").toLowerCase() === q || String(o.orderRef || "").toLowerCase() === q
      ) || null
    );
  });
}

function listOrders(limit = 50) {
  return withStore((store) => {
    return [...store.orders]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, Number(limit));
  });
}

function importInventory(items) {
  return withStore((store) => {
    const prepared = items.map((item) => ({
      id: randomId("inv"),
      sku: item.sku,
      label: item.label || item.username,
      username: item.username,
      password: item.password,
      host: item.host,
      port: item.port || 3389,
      status: "available",
      createdAt: new Date().toISOString()
    }));

    store.inventory.push(...prepared);
    return prepared.length;
  });
}

function getInventorySummary() {
  return withStore((store) => {
    const bySku = {};
    for (const item of store.inventory) {
      if (!bySku[item.sku]) {
        bySku[item.sku] = { total: 0, available: 0, sold: 0 };
      }
      bySku[item.sku].total += 1;
      if (item.status === "available") bySku[item.sku].available += 1;
      if (item.status === "sold") bySku[item.sku].sold += 1;
    }
    return bySku;
  });
}

function claimInventory(sku, store) {
  const candidate = store.inventory.find((item) => item.sku === sku && item.status === "available");
  if (!candidate) {
    return null;
  }
  candidate.status = "sold";
  candidate.soldAt = new Date().toISOString();
  return candidate;
}

function markPaymentAndAutoFulfill({
  orderId,
  provider,
  providerPaymentId,
  paidAmount,
  currency,
  eventId
}) {
  return withStore((store) => {
    if (eventId && store.processedEvents.includes(eventId)) {
      return { idempotent: true, order: store.orders.find((o) => o.id === orderId) || null };
    }

    const order = store.orders.find((o) => o.id === orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    if (order.status === "fulfilled") {
      if (eventId) store.processedEvents.push(eventId);
      return { idempotent: false, order, inventory: null };
    }

    if (Number(order.price) !== Number(paidAmount) || order.currency !== currency) {
      throw new Error("Paid amount/currency mismatch");
    }

    order.payment = {
      provider,
      providerPaymentId,
      paidAmount,
      currency,
      paidAt: new Date().toISOString()
    };
    order.status = "paid";

    const inv = claimInventory(order.sku, store);
    if (inv) {
      order.delivery = {
        mode: "stock",
        host: inv.host,
        port: inv.port,
        username: inv.username,
        password: inv.password,
        deliveredAt: new Date().toISOString()
      };
      order.status = "fulfilled";
    }

    order.updatedAt = new Date().toISOString();
    if (eventId) store.processedEvents.push(eventId);

    return { idempotent: false, order, inventory: inv };
  });
}

function manualFulfillOrder({ orderId, host, port, username, password, note }) {
  return withStore((store) => {
    const order = store.orders.find((o) => o.id === orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (order.status !== "paid" && order.status !== "pending") {
      throw new Error("Order is not eligible for manual fulfillment");
    }

    order.delivery = {
      mode: "manual",
      host,
      port: port || 3389,
      username,
      password,
      note: note || "",
      deliveredAt: new Date().toISOString()
    };
    order.status = "fulfilled";
    order.updatedAt = new Date().toISOString();

    return order;
  });
}

function submitPaymentProof({ orderId, paymentMethod, paymentRef, submittedBy }) {
  return withStore((store) => {
    const order = store.orders.find((o) => o.id === orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    order.paymentProof = {
      paymentMethod,
      paymentRef,
      submittedBy,
      submittedAt: new Date().toISOString()
    };

    if (order.status === "pending") {
      order.status = "awaiting_payment_review";
    }

    order.updatedAt = new Date().toISOString();
    return order;
  });
}

module.exports = {
  createOrder,
  getOrder,
  listOrders,
  importInventory,
  getInventorySummary,
  markPaymentAndAutoFulfill,
  manualFulfillOrder,
  submitPaymentProof
};
