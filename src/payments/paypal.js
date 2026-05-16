const { config } = require("../config");

function getHeader(headers, name) {
  return headers[name.toLowerCase()] || headers[name] || "";
}

async function getPayPalAccessToken() {
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");

  const response = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get PayPal access token: ${response.status} ${text}`);
  }

  const body = await response.json();
  return body.access_token;
}

async function verifyPayPalWebhook(headers, eventBody) {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET || !config.PAYPAL_WEBHOOK_ID) {
    throw new Error("PayPal credentials/webhook ID not configured");
  }

  const token = await getPayPalAccessToken();

  const verificationPayload = {
    auth_algo: getHeader(headers, "paypal-auth-algo"),
    cert_url: getHeader(headers, "paypal-cert-url"),
    transmission_id: getHeader(headers, "paypal-transmission-id"),
    transmission_sig: getHeader(headers, "paypal-transmission-sig"),
    transmission_time: getHeader(headers, "paypal-transmission-time"),
    webhook_id: config.PAYPAL_WEBHOOK_ID,
    webhook_event: eventBody
  };

  const response = await fetch(`${config.paypalBaseUrl}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(verificationPayload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal webhook verification failed: ${response.status} ${text}`);
  }

  const result = await response.json();
  return result.verification_status === "SUCCESS";
}

module.exports = {
  verifyPayPalWebhook
};
