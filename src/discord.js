const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

let client;
let ready = false;
let handlers = {
  createOrderFromSelection: null,
  submitPaymentProof: null,
  addStockItems: null,
  getInventorySummary: null,
  getLiveStockMessageId: null,
  setLiveStockMessageId: null,
  getPaymentInstructions: null,
  staffLogChannelId: null,
  liveStockChannelId: null
};

function isIgnorableInteractionError(error) {
  return Boolean(
    error &&
      (error.code === 40060 ||
        error.code === 10062 ||
        String(error.message || "").includes("acknowledged") ||
        String(error.message || "").toLowerCase().includes("unknown interaction"))
  );
}

async function safeReply(interaction, payload) {
  const options = { ...payload };
  if (typeof options.flags === "undefined") {
    options.flags = MessageFlags.Ephemeral;
  }
  delete options.ephemeral;

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(options);
  }
  return interaction.reply(options);
}

async function safeShowModal(interaction, modal) {
  if (interaction.deferred || interaction.replied) {
    return;
  }

  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (isIgnorableInteractionError(error)) {
      return;
    }
    throw error;
  }
}

const CUSTOM_IDS = {
  buyOpen: "buy_open",
  paidOpen: "paid_open",
  buyModal: "buy_modal",
  paidModal: "paid_modal",
  stockOpen: "stock_open",
  stockModal: "stock_modal"
};

function buildBuyPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Buy RDP")
    .setDescription(
      [
        "Click **Buy Now** to create your order.",
        "Then submit payment and click **I Paid** to send your reference.",
        "Delivery is sent by DM once your order is fulfilled."
      ].join("\n")
    )
    .setColor(0x2b8a3e);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.buyOpen)
      .setLabel("Buy Now")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.paidOpen)
      .setLabel("I Paid")
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

function buildStockPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Staff Stock Input")
    .setDescription("Staff can click **Add Stock** to input one inventory item.")
    .setColor(0x1d4ed8);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CUSTOM_IDS.stockOpen).setLabel("Add Stock").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

function canManageStock(interaction) {
  if (!interaction.inGuild()) return false;
  return interaction.memberPermissions?.has("ManageMessages") || false;
}

async function writeStaffLog(message) {
  if (!client || !ready || !handlers.staffLogChannelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(handlers.staffLogChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
    }
  } catch (error) {
    console.warn(`Staff log skipped: ${error.message}`);
  }
}

function buildLiveStockText(summary) {
  const entries = Object.entries(summary || {});
  if (!entries.length) {
    return [
      "Live Stock Update",
      "No inventory available.",
      `Updated: ${new Date().toISOString()}`
    ].join("\n");
  }

  const sorted = entries.sort((a, b) => a[0].localeCompare(b[0]));
  const headers = ["STATUS", "SKU", "AVAILABLE", "SOLD", "TOTAL"];

  const statusValues = sorted.map(([, c]) => (Number(c.available) > 0 ? "GREEN" : "RED"));

  const statusWidth = Math.max(headers[0].length, ...statusValues.map((v) => v.length));
  const skuWidth = Math.max(
    headers[1].length,
    ...sorted.map(([sku]) => String(sku).length)
  );
  const availWidth = Math.max(
    headers[2].length,
    ...sorted.map(([, c]) => String(c.available).length)
  );
  const soldWidth = Math.max(
    headers[3].length,
    ...sorted.map(([, c]) => String(c.sold).length)
  );
  const totalWidth = Math.max(
    headers[4].length,
    ...sorted.map(([, c]) => String(c.total).length)
  );

  const padR = (value, width) => String(value).padEnd(width, " ");
  const padL = (value, width) => String(value).padStart(width, " ");

  const lineHeader =
    `${padR(headers[0], statusWidth)}  ` +
    `${padR(headers[1], skuWidth)}  ` +
    `${padL(headers[2], availWidth)}  ` +
    `${padL(headers[3], soldWidth)}  ` +
    `${padL(headers[4], totalWidth)}`;

  const separator =
    `${"-".repeat(statusWidth)}  ` +
    `${"-".repeat(skuWidth)}  ` +
    `${"-".repeat(availWidth)}  ` +
    `${"-".repeat(soldWidth)}  ` +
    `${"-".repeat(totalWidth)}`;

  const rows = sorted.map(([sku, counts]) => {
    const status = Number(counts.available) > 0 ? "GREEN" : "RED";
    return (
      `${padR(status, statusWidth)}  ` +
      `${padR(sku, skuWidth)}  ` +
      `${padL(counts.available, availWidth)}  ` +
      `${padL(counts.sold, soldWidth)}  ` +
      `${padL(counts.total, totalWidth)}`
    );
  });

  return [
    "Live Stock Update",
    "GREEN=In Stock | RED=Out of Stock",
    "```",
    lineHeader,
    separator,
    ...rows,
    "```",
    `Updated: ${new Date().toISOString()}`
  ].join("\n");
}

async function publishLiveStockSummary() {
  if (!client || !ready || !handlers.liveStockChannelId || !handlers.getInventorySummary) {
    return;
  }

  try {
    const channelId = handlers.liveStockChannelId;
    const summary = await handlers.getInventorySummary();
    const text = buildLiveStockText(summary);
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const existingMessageId = handlers.getLiveStockMessageId
      ? await handlers.getLiveStockMessageId(channelId)
      : null;

    if (existingMessageId) {
      try {
        const msg = await channel.messages.fetch(existingMessageId);
        await msg.edit(text);
        return;
      } catch (_error) {
        // Fall through to create a new board message when old one is missing.
      }
    }

    const created = await channel.send(text);
    if (handlers.setLiveStockMessageId) {
      await handlers.setLiveStockMessageId(channelId, created.id);
    }
  } catch (error) {
    console.warn(`Live stock update skipped: ${error.message}`);
  }
}

async function handleBuyModal(interaction) {
  try {
    if (!handlers.createOrderFromSelection) {
      await safeReply(interaction, { content: "Order flow is not configured yet." });
      return;
    }

    const sku = interaction.fields.getTextInputValue("sku").trim();
    const paymentMethod = interaction.fields.getTextInputValue("payment_method").trim().toLowerCase();

    const order = await handlers.createOrderFromSelection({
      discordUserId: interaction.user.id,
      sku,
      paymentMethod
    });

    const instructions = handlers.getPaymentInstructions
      ? handlers.getPaymentInstructions(paymentMethod)
      : "Payment instructions are not configured.";

    const replyLines = [
      `Order ID: ${order.id}`,
      `Order Ref: ${order.orderRef || "(pending)"}`,
      `Product: ${order.sku}`,
      `Amount: ${order.price} ${order.currency}`,
      `Payment method: ${paymentMethod}`,
      "",
      "Payment instructions:",
      instructions,
      "",
      "After paying, click **I Paid** and submit your order ID + payment reference."
    ];

    await safeReply(interaction, { content: replyLines.join("\n") });
  } catch (error) {
    await safeReply(interaction, { content: `Could not create order: ${error.message}` });
  }
}

async function handlePaidModal(interaction) {
  try {
    if (!handlers.submitPaymentProof) {
      await safeReply(interaction, { content: "Payment proof flow is not configured yet." });
      return;
    }

    const orderId = interaction.fields.getTextInputValue("order_id").trim();
    const paymentRef = interaction.fields.getTextInputValue("payment_ref").trim();

    const result = await handlers.submitPaymentProof({
      orderId,
      discordUserId: interaction.user.id,
      paymentRef
    });

    await writeStaffLog(
      `Payment proof submitted: order=${orderId} user=${interaction.user.id} ref=${paymentRef} status=${result.order.status}`
    );

    if (result.order.status === "fulfilled") {
      await safeReply(interaction, {
        content: `Payment accepted. Your order ${orderId} has been delivered to your DM.`
      });
      return;
    }

    await safeReply(interaction, {
      content: `Payment proof received for ${orderId}. Status: ${result.order.status}.`
    });
  } catch (error) {
    await safeReply(interaction, { content: `Could not submit payment proof: ${error.message}` });
  }
}

async function handleStockModal(interaction) {
  try {
    if (!canManageStock(interaction)) {
      await safeReply(interaction, { content: "Only staff can add stock." });
      return;
    }

    if (!handlers.addStockItems) {
      await safeReply(interaction, { content: "Stock flow is not configured yet." });
      return;
    }

    const sku = interaction.fields.getTextInputValue("stock_sku").trim();
    const label = interaction.fields.getTextInputValue("stock_label").trim();
    const hostPortRaw = interaction.fields.getTextInputValue("stock_host_port").trim();
    const username = interaction.fields.getTextInputValue("stock_username").trim();
    const password = interaction.fields.getTextInputValue("stock_password").trim();

    const [hostPart, portPart] = hostPortRaw.split(":");
    const host = String(hostPart || "").trim();
    const port = Number(String(portPart || "3389").trim());
    if (!sku || !host || !username || !password || Number.isNaN(port)) {
      await safeReply(interaction, {
        content: "Invalid input. Use host as ip:port (example 1.2.3.4:3389)."
      });
      return;
    }

    const count = await handlers.addStockItems([
      {
        sku,
        label: label || username,
        host,
        port,
        username,
        password
      }
    ]);

    await safeReply(interaction, {
      content: `Stock added successfully. Imported: ${count}. SKU: ${sku}`
    });

    await writeStaffLog(`Stock added by ${interaction.user.id}: sku=${sku} host=${host} label=${label || username}`);
    await publishLiveStockSummary();
  } catch (error) {
    await safeReply(interaction, { content: `Could not add stock: ${error.message}` });
  }
}

async function startDiscordClient(token, options = {}) {
  if (!token) {
    console.warn("DISCORD_BOT_TOKEN missing: delivery will be logged but no DM will be sent.");
    return;
  }

  handlers = {
    createOrderFromSelection: options.createOrderFromSelection || null,
    submitPaymentProof: options.submitPaymentProof || null,
    addStockItems: options.addStockItems || null,
    getInventorySummary: options.getInventorySummary || null,
    getLiveStockMessageId: options.getLiveStockMessageId || null,
    setLiveStockMessageId: options.setLiveStockMessageId || null,
    getPaymentInstructions: options.getPaymentInstructions || null,
    staffLogChannelId: options.staffLogChannelId || null,
    liveStockChannelId: options.liveStockChannelId || null
  };

  client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, () => {
    ready = true;
    console.log(`Discord bot connected as ${client.user.tag}`);
    publishLiveStockSummary().catch((error) => {
      console.warn(`Initial live stock update skipped: ${error.message}`);
    });
  });

  client.on("error", (error) => {
    console.error("Discord client error:", error);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        if (interaction.customId === CUSTOM_IDS.buyOpen) {
          const modal = new ModalBuilder().setCustomId(CUSTOM_IDS.buyModal).setTitle("Create Order");

          const sku = new TextInputBuilder()
            .setCustomId("sku")
            .setLabel("Product SKU (example: rdp-basic)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const paymentMethod = new TextInputBuilder()
            .setCustomId("payment_method")
            .setLabel("Payment Method (paypal/gcash)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(sku),
            new ActionRowBuilder().addComponents(paymentMethod)
          );

          await safeShowModal(interaction, modal);
          return;
        }

        if (interaction.customId === CUSTOM_IDS.paidOpen) {
          const modal = new ModalBuilder().setCustomId(CUSTOM_IDS.paidModal).setTitle("Submit Payment Proof");

          const orderId = new TextInputBuilder()
            .setCustomId("order_id")
            .setLabel("Order ID")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const paymentRef = new TextInputBuilder()
            .setCustomId("payment_ref")
            .setLabel("Transaction ID / reference")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(orderId),
            new ActionRowBuilder().addComponents(paymentRef)
          );

          await safeShowModal(interaction, modal);
        }

        if (interaction.customId === CUSTOM_IDS.stockOpen) {
          if (!canManageStock(interaction)) {
            await safeReply(interaction, { content: "Only staff can use this panel." });
            return;
          }

          const modal = new ModalBuilder().setCustomId(CUSTOM_IDS.stockModal).setTitle("Add Stock Item");

          const sku = new TextInputBuilder()
            .setCustomId("stock_sku")
            .setLabel("Product SKU (example: rdp-basic)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const label = new TextInputBuilder()
            .setCustomId("stock_label")
            .setLabel("Label (example: BASIC-001)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

          const hostPort = new TextInputBuilder()
            .setCustomId("stock_host_port")
            .setLabel("Host:Port (example 1.2.3.4:3389)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const username = new TextInputBuilder()
            .setCustomId("stock_username")
            .setLabel("Username")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const password = new TextInputBuilder()
            .setCustomId("stock_password")
            .setLabel("Password")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(sku),
            new ActionRowBuilder().addComponents(label),
            new ActionRowBuilder().addComponents(hostPort),
            new ActionRowBuilder().addComponents(username),
            new ActionRowBuilder().addComponents(password)
          );

          await safeShowModal(interaction, modal);
        }

        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === CUSTOM_IDS.buyModal) {
          await handleBuyModal(interaction);
          return;
        }

        if (interaction.customId === CUSTOM_IDS.paidModal) {
          await handlePaidModal(interaction);
        }

        if (interaction.customId === CUSTOM_IDS.stockModal) {
          await handleStockModal(interaction);
        }
      }
    } catch (error) {
      if (isIgnorableInteractionError(error)) {
        return;
      }
      console.error("Interaction handling error:", error);
    }
  });

  await client.login(token);
}

async function sendDeliveryDM(discordUserId, message) {
  if (!client || !ready) {
    console.warn(`Discord not ready. Delivery for ${discordUserId}: ${message}`);
    return;
  }

  const user = await client.users.fetch(discordUserId);
  await user.send(message);
}

async function postBuyPanel(channelId) {
  if (!client || !ready) {
    throw new Error("Discord client is not ready");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Invalid channel");
  }

  const panel = buildBuyPanelMessage();
  await channel.send(panel);
}

async function postStockPanel(channelId) {
  if (!client || !ready) {
    throw new Error("Discord client is not ready");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Invalid channel");
  }

  const panel = buildStockPanelMessage();
  await channel.send(panel);
}

async function refreshLiveStockSummary() {
  await publishLiveStockSummary();
}

async function sendChannelMessage(channelId, content) {
  if (!client || !ready) {
    throw new Error("Discord client is not ready");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error("Invalid channel");
  }

  await channel.send(content);
}

module.exports = {
  startDiscordClient,
  sendDeliveryDM,
  postBuyPanel,
  postStockPanel,
  refreshLiveStockSummary,
  sendChannelMessage
};
