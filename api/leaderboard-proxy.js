/**
 * Vercel Serverless Function — Shopify Leaderboard Proxy
 * Uses Client Credentials OAuth grant (new Dev Dashboard flow)
 *
 * Environment variables (set in Vercel dashboard):
 *   SHOPIFY_STORE_DOMAIN   = mysmartbazaar.myshopify.com
 *   SHOPIFY_CLIENT_ID      = your_client_id
 *   SHOPIFY_CLIENT_SECRET  = your_client_secret
 *   ALLOWED_ORIGIN         = https://mysmartbazaar.com
 */

let cachedToken = null;
let tokenExpiresAt = 0;

export default async function handler(req, res) {
  const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || "";
  const dashKey = req.query.key || "";
  const isDashboard = DASHBOARD_SECRET && dashKey === DASHBOARD_SECRET;
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN || "https://mysmartbazaar.com",
    "https://www.mysmartbazaar.com"
  ];
  const origin = req.headers.origin || "";
  const corsOrigin = isDashboard ? "*" : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);

  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SHOP          = process.env.SHOPIFY_STORE_DOMAIN;
  const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      error: "Missing env vars. Set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET."
    });
  }

  try {
    const accessToken = await getAccessToken(SHOP, CLIENT_ID, CLIENT_SECRET);

    // Current month date range
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth();
    const start = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();
    const end   = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59)).toISOString();
    const qStart = req.query.created_at_min || start;
    const qEnd   = req.query.created_at_max || end;

    // Fetch all orders (paginated)
    const allOrders = [];
    let pageUrl = buildUrl(SHOP, qStart, qEnd);

    while (pageUrl) {
      const response = await fetchWithRetry(pageUrl, accessToken, SHOP, CLIENT_ID, CLIENT_SECRET);

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`Shopify API error: ${response.status}`, errBody);
        return res.status(502).json({
          error: `Shopify API returned ${response.status}`,
          detail: errBody.substring(0, 300),
        });
      }

      const data = await response.json();
      if (data.orders) allOrders.push(...data.orders);
      pageUrl = getNextPageUrl(response.headers.get("link"));
    }

    // Aggregate by customer
    const customerMap = new Map();
    for (const order of allOrders) {
      if (order.cancelled_at) continue;
      if (!["paid", "partially_refunded"].includes(order.financial_status)) continue;
      if (!order.customer) continue;

      const id = order.customer.id;
      if (customerMap.has(id)) {
        const e = customerMap.get(id);
        e.orderCount += 1;
        e.totalSpend += parseFloat(order.total_price || 0);
        e.lastOrderNum = order.order_number;
      } else {
        customerMap.set(id, {
          customerId: id,
          name: [order.customer.first_name, order.customer.last_name].filter(Boolean).join(" ") || "Guest",
          email: order.customer.email || "",
          orderCount: 1,
          totalSpend: parseFloat(order.total_price || 0),
          lastOrderNum: order.order_number,
        });
      }
    }

    const ranked = Array.from(customerMap.values())
      .sort((a, b) => b.totalSpend - a.totalSpend || b.orderCount - a.orderCount);

    return res.status(200).json({
      orders: allOrders.map(o => ({
        id: o.id,
        order_number: o.order_number,
        total_price: o.total_price,
        financial_status: o.financial_status,
        cancelled_at: o.cancelled_at,
        created_at: o.created_at,
        customer: o.customer ? {
          id: o.customer.id,
          first_name: o.customer.first_name,
          last_name: o.customer.last_name,
          email: o.customer.email,
        } : null,
      })),
      leaderboard: ranked.slice(0, 20),
      meta: {
        totalOrders: allOrders.length,
        qualifiedOrders: ranked.reduce((s, c) => s + c.orderCount, 0),
        uniqueCustomers: customerMap.size,
        periodStart: qStart,
        periodEnd: qEnd,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[Leaderboard Proxy]", err);
    return res.status(500).json({ error: err.message });
  }
}

// OAuth token
async function getAccessToken(shop, clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedToken;
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 86400) * 1000;
  return cachedToken;
}

// Retry on 401
async function fetchWithRetry(url, token, shop, clientId, clientSecret) {
  let response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const freshToken = await getAccessToken(shop, clientId, clientSecret);
    response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": freshToken,
        "Content-Type": "application/json",
      },
    });
  }

  return response;
}

// Helpers
function buildUrl(shop, startDate, endDate) {
  const params = new URLSearchParams({
    status: "any",
    created_at_min: startDate,
    created_at_max: endDate,
    limit: "250",
    fields: "id,order_number,total_price,financial_status,cancelled_at,created_at,customer",
  });
  return `https://${shop}/admin/api/2024-10/orders.json?${params}`;
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
