const { z } = require("zod");

const envSchema = z.object({
  PORT: z.string().default("3000"),
  ADMIN_API_KEY: z.string().min(8, "ADMIN_API_KEY must be at least 8 characters"),
  DISCORD_BOT_TOKEN: z.string().optional(),
  STAFF_LOG_CHANNEL_ID: z.string().optional(),
  LIVE_STOCK_CHANNEL_ID: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  GCASH_WEBHOOK_SECRET: z.string().optional(),
  CATALOG_JSON: z.string().optional(),
  PAYMENT_METHOD_INSTRUCTIONS_JSON: z.string().optional(),
  AUTO_FULFILL_ON_PROOF: z.string().default("false"),
  AUTO_AD_ENABLED: z.string().default("false"),
  AUTO_AD_CHANNEL_ID: z.string().optional(),
  AUTO_AD_CHANNEL_IDS: z.string().optional(),
  AUTO_AD_INTERVAL_MINUTES: z.string().default("60"),
  AUTO_AD_MESSAGE: z.string().default("RDP STOCK AVAILABLE. DM OR CLICK BUY PANEL TO ORDER."),
  AUTO_AD_MENTION_ROLE_ID: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = {
  
  config: {
    ...parsed.data,
    port: Number(parsed.data.PORT),
    autoFulfillOnProof: String(parsed.data.AUTO_FULFILL_ON_PROOF).toLowerCase() === "true",
    autoAdEnabled: String(parsed.data.AUTO_AD_ENABLED).toLowerCase() === "true",
    autoAdChannelId: parsed.data.AUTO_AD_CHANNEL_ID || "",
    autoAdChannelIds: String(parsed.data.AUTO_AD_CHANNEL_IDS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    autoAdIntervalMinutes: Math.max(5, Number(parsed.data.AUTO_AD_INTERVAL_MINUTES) || 60),
    autoAdMessage: parsed.data.AUTO_AD_MESSAGE,
    autoAdMentionRoleId: parsed.data.AUTO_AD_MENTION_ROLE_ID || "",
    catalogJson: parsed.data.CATALOG_JSON || "",
    paymentMethodInstructionsJson: parsed.data.PAYMENT_METHOD_INSTRUCTIONS_JSON || "",
    liveStockChannelId: parsed.data.LIVE_STOCK_CHANNEL_ID || "",
    paypalBaseUrl:
      parsed.data.PAYPAL_MODE === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com"
  }
};
