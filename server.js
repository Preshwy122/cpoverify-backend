
const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://preshwy122.github.io";

const WICKSPEND_URL =
  process.env.WICKSPEND_BASE_URL || "https://wickspend.com/api/v1";

const SAMEEHA_URL = "https://sameehasocialhub.com/api/v1";

const MYSMM_URL =
  process.env.MYSMM_BASE_URL || "https://mysmm.co/api/v2";

const USD_TO_NGN_RATE = Number(process.env.USD_TO_NGN_RATE || 1400);
const BOOST_MARKUP_PERCENT = Number(
  process.env.BOOST_MARKUP_PERCENT || 20
);

// MySMM rate units must be confirmed before enabling orders.
// Set MYSMM_RATE_UNIT to "per1000" or "perunit" only after
// confirming how mysmm.co calculates its service rates.

const MYSMM_RATE_UNIT = process.env.MYSMM_RATE_UNIT || "";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// FIREBASE INITIALIZATION
// --------------------------------------------------

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    privateKey &&
    process.env.FIREBASE_DATABASE_URL
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

function db() {
  if (!admin.apps.length) {
    throw new Error("Firebase backend is not configured");
  }

  return admin.database();
}

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validText(value, max = 200) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

function makeRequestKey(value) {
  if (validText(value, 120) && value.trim().length >= 8) {
    return value.trim();
  }

  return null;
}

function errorResponse(res, error, status = 500) {
  console.error(error);
  return res.status(status).json({
    error: "The request could not be completed"
  });
}

async function providerRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();
    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    return {
      status: response.status,
      ok: response.ok,
      data
    };
  } finally {
    clearTimeout(timeout);
  }
}

function wickHeaders() {
  if (!process.env.WICKSPEND_API_KEY) {
    throw new Error("WICKSPEND_API_KEY is missing");
  }

  return {
    "X-API-Key": process.env.WICKSPEND_API_KEY,
    "Content-Type": "application/json"
  };
}

function mySmmUrl(action) {
  if (!process.env.MYSMM_API_KEY) {
    throw new Error("MYSMM_API_KEY is missing");
  }

  const url = new URL(MYSMM_URL);
  url.searchParams.set("key", process.env.MYSMM_API_KEY);
  url.searchParams.set("action", action);
  return url;
}

async function getJson(url, headers = {}) {
  return providerRequest(url, {
    method: "GET",
    headers
  });
}

async function postJson(url, body, headers = {}) {
  return providerRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

async function verifyFirebaseUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const decoded = await admin.auth().verifyIdToken(
      header.slice(7)
    );

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired authentication token"
    });
  }
}

function verifyAdmin(req, res, next) {
  const adminUID = process.env.ADMIN_UID;

  if (!adminUID) {
    return res.status(503).json({
      error: "ADMIN_UID is not configured"
    });
  }

  if (req.user.uid !== adminUID) {
    return res.status(403).json({
      error: "Admin access required"
    });
  }

  next();
}

// --------------------------------------------------
// WALLET HELPERS
// Amounts are stored in NGN.
// --------------------------------------------------

async function changeWallet(uid, amount, transactionId, type, details = {}) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Invalid wallet amount");
  }

  const root = db().ref(`users/${uid}/wallet`);
  const balanceRef = root.child("balance");

  const transactionRef = db().ref(
    `users/${uid}/transactions/${transactionId}`
  );

  const existing = await transactionRef.get();

  if (existing.exists()) {
    return {
      duplicate: true,
      balance: safeNumber((await balanceRef.get()).val())
    };
  }

  if (type === "debit") {
    const result = await balanceRef.transaction(current => {
      const balance = safeNumber(current);

      if (balance < amount) {
        return;
      }

      return balance - amount;
    });

    if (!result.committed) {
      throw new Error("INSUFFICIENT_BALANCE");
    }
  } else {
    await balanceRef.transaction(current => {
      return safeNumber(current) + amount;
    });
  }

  await transactionRef.set({
    type,
    amount,
    details,
    createdAt: admin.database.ServerValue.TIMESTAMP
  });

  return {
    duplicate: false,
    balance: safeNumber((await balanceRef.get()).val())
  };
}

async function refundWallet(uid, amount, transactionId, details = {}) {
  return changeWallet(
    uid,
    amount,
    transactionId,
    "credit",
    {
      reason: "Confirmed provider refund",
      ...details
    }
  );
}

// --------------------------------------------------
// HEALTH / USER / ADMIN
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "CPOVERIFY Backend",
    status: "running"
  });
});

app.get("/api/me", verifyFirebaseUser, (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email || null
  });
});

app.get(
  "/api/admin/check",
  verifyFirebaseUser,
  verifyAdmin,
  (req, res) => {
    res.json({ admin: true });
  }
);

app.get("/api/wallet", verifyFirebaseUser, async (req, res) => {
  try {
    const snapshot = await db()
      .ref(`users/${req.user.uid}/wallet/balance`)
      .get();

    res.json({
      balance: safeNumber(snapshot.val())
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// --------------------------------------------------
// ADMIN PRICING
//
// Structure:
// settings/pricing/{provider}/{type}/{serviceId}
//
// Examples:
// wickspend/numbers/OFFER_ID
// wickspend/rentals/OFFER_ID
// sameeha/logs/SERVICE_ID
// --------------------------------------------------

app.get(
  "/api/admin/pricing",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db().ref("settings/pricing").get();
      res.json(snapshot.val() || {});
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.put(
  "/api/admin/pricing/:provider/:type/:serviceId",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { provider, type, serviceId } = req.params;
      const price = Number(req.body.price);

      const allowed = {
        wickspend: ["numbers", "rentals"],
        sameeha: ["logs"]
      };

      if (
        !allowed[provider] ||
        !allowed[provider].includes(type) ||
        !validText(serviceId, 150) ||
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res.status(400).json({
          error: "Invalid pricing details"
        });
      }

      await db()
        .ref(`settings/pricing/${provider}/${type}/${serviceId}`)
        .set({
          price,
          updatedAt: admin.database.ServerValue.TIMESTAMP
        });

      res.json({
        success: true,
        price
      });
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

async function attachPrices(items, provider, type, idFields) {
  const snapshot = await db()
    .ref(`settings/pricing/${provider}/${type}`)
    .get();

  const prices = snapshot.val() || {};

  if (!Array.isArray(items)) {
    return items;
  }

  return items.map(item => {
    let id = null;

    for (const field of idFields) {
      if (item && item[field] !== undefined) {
        id = String(item[field]);
        break;
      }
    }

    return {
      ...item,
      customerPrice: id && prices[id]
        ? safeNumber(prices[id].price)
        : null
    };
  });
}

// --------------------------------------------------
// SAMEEHA SOCIAL HUB — ACCOUNT LOGS
// --------------------------------------------------

app.get(
  "/api/provider/categories",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const result = await getJson(
        `${SAMEEHA_URL}/categories`,
        {
          Authorization: `Bearer ${process.env.SAMEEHA_API_KEY}`
        }
      );

      if (!result.ok) {
        return res.status(502).json({
          error: "Sameeha categories request failed"
        });
      }

      res.json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.get(
  "/api/provider/products",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const result = await getJson(
        `${SAMEEHA_URL}/products`,
        {
          Authorization: `Bearer ${process.env.SAMEEHA_API_KEY}`
        }
      );

      if (!result.ok) {
        return res.status(502).json({
          error: "Sameeha products request failed"
        });
      }

      const items = Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.data.products)
          ? result.data.products
          : [];

      const priced = await attachPrices(
        items,
        "sameeha",
        "logs",
        ["service", "id", "product_id", "service_id"]
      );

      res.json(priced);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// --------------------------------------------------
// MANUALLY ADDED ACCOUNT LOGS
// --------------------------------------------------

app.get(
  "/api/manual-logs",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const snapshot = await db().ref("manualLogs").get();
      const logs = snapshot.val() || {};

      const result = Object.entries(logs)
        .filter(([, item]) => item && item.active !== false)
        .map(([id, item]) => ({ id, ...item }));

      res.json(result);
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.post(
  "/api/admin/manual-logs",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { title, description, price, category } = req.body;
      const amount = Number(price);

      if (
        !validText(title, 150) ||
        !Number.isFinite(amount) ||
        amount < 0
      ) {
        return res.status(400).json({
          error: "A valid title and price are required"
        });
      }

      const ref = db().ref("manualLogs").push();

      await ref.set({
        title: title.trim(),
        description: String(description || ""),
        category: String(category || "General"),
        price: amount,
        active: true,
        createdAt: admin.database.ServerValue.TIMESTAMP
      });

      res.json({
        success: true,
        id: ref.key
      });
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.put(
  "/api/admin/manual-logs/:id",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { title, description, price, category, active } = req.body;
      const amount = Number(price);

      if (
        !validText(title, 150) ||
        !Number.isFinite(amount) ||
        amount < 0
      ) {
        return res.status(400).json({
          error: "Invalid log details"
        });
      }

      const ref = db().ref(`manualLogs/${req.params.id}`);

      if (!(await ref.get()).exists()) {
        return res.status(404).json({
          error: "Log not found"
        });
      }

      await ref.update({
        title: title.trim(),
        description: String(description || ""),
        category: String(category || "General"),
        price: amount,
        active: active !== false,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });

      res.json({ success: true });
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.delete(
  "/api/admin/manual-logs/:id",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      await db().ref(`manualLogs/${req.params.id}`).remove();
      res.json({ success: true });
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

// --------------------------------------------------
// WICKSPEND — NUMBERS AND LONG RENTALS ONLY
// --------------------------------------------------

app.get(
  "/api/wickspend/numbers/catalog",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const url = new URL(`${WICKSPEND_URL}/numbers/catalog`);

      if (req.query.country_code) {
        url.searchParams.set(
          "country_code",
          String(req.query.country_code)
        );
      }

      if (req.query.service_code) {
        url.searchParams.set(
          "service_code",
          String(req.query.service_code)
        );
      }

      const result = await getJson(url, wickHeaders());

      if (!result.ok) {
        return res.status(502).json({
          error: "WickSpend number catalogue unavailable",
          providerStatus: result.status
        });
      }

      const data = result.data;
      const offers = Array.isArray(data)
        ? data
        : Array.isArray(data.offers)
          ? data.offers
          : Array.isArray(data.data)
            ? data.data
            : null;

      if (!offers) {
        return res.json(data);
      }

      const priced = await attachPrices(
        offers,
        "wickspend",
        "numbers",
        ["offer_id", "id", "provider_id", "service_code"]
      );

      res.json({
        ...(!Array.isArray(data) ? data : {}),
        offers: priced
      });
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.get(
  "/api/wickspend/rentals/catalog",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const result = await getJson(
        `${WICKSPEND_URL}/rentals/catalog`,
        wickHeaders()
      );

      if (!result.ok) {
        return res.status(502).json({
          error: "WickSpend rental catalogue unavailable",
          providerStatus: result.status
        });
      }

      const data = result.data;
      const offers = Array.isArray(data)
        ? data
        : Array.isArray(data.offers)
          ? data.offers
          : Array.isArray(data.data)
            ? data.data
            : null;

      if (!offers) {
        return res.json(data);
      }

      const priced = await attachPrices(
        offers,
        "wickspend",
        "rentals",
        ["offer_id", "id", "service_code"]
      );

      res.json({
        ...(!Array.isArray(data) ? data : {}),
        offers: priced
      });
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.get(
  "/api/wickspend/balance",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await getJson(
        `${WICKSPEND_URL}/balance`,
        wickHeaders()
      );

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// Purchase attempts are stored before calling the provider.
// A 202 response is kept pending and must not be retried
// with a new request key.

async function createWickOrder({
  uid,
  kind,
  requestKey,
  payload,
  customerPrice
}) {
  const ref = db().ref(
    `users/${uid}/wickspendRequests/${requestKey}`
  );

  const existing = await ref.get();

  if (existing.exists()) {
    return {
      duplicate: true,
      order: existing.val()
    };
  }

  const debitId = `wick_${requestKey}`;

  await changeWallet(
    uid,
    Math.round(customerPrice * 100),
    debitId,
    "debit",
    {
      provider: "wickspend",
      kind,
      requestKey
    }
  );

  const record = {
    provider: "wickspend",
    kind,
    requestKey,
    payload,
    chargedAmount: Math.round(customerPrice * 100),
    status: "processing",
    createdAt: admin.database.ServerValue.TIMESTAMP
  };

  await ref.set(record);

  return {
    duplicate: false,
    ref,
    record
  };
}

async function completeWickPurchase({
  uid,
  kind,
  requestKey,
  payload,
  price,
  endpoint
}) {
  if (!Number.isFinite(price) || price <= 0) {
    return {
      status: 400,
      body: {
        error: "This offer has no valid admin selling price"
      }
    };
  }

  const created = await createWickOrder({
    uid,
    kind,
    requestKey,
    payload,
    customerPrice: price
  });

  if (created.duplicate) {
    return {
      status: 200,
      body: {
        duplicate: true,
        order: created.order
      }
    };
  }

  let result;

  try {
    result = await postJson(
      `${WICKSPEND_URL}${endpoint}`,
      payload,
      wickHeaders()
    );
  } catch (error) {
    await created.ref.update({
      status: "provider_status_unknown",
      error: "Provider connection interrupted"
    });

    return {
      status: 202,
      body: {
        status: "provider_status_unknown",
        request_key: requestKey,
        message: "Check the same request again. Do not create a new request key."
      }
    };
  }

  if (result.status === 202) {
    await created.ref.update({
      status: "provider_status_unknown",
      providerResponse: result.data
    });

    return {
      status: 202,
      body: {
        status: "provider_status_unknown",
        request_key: requestKey,
        provider: result.data
      }
    };
  }

  if (result.ok) {
    await created.ref.update({
      status: "submitted",
      providerResponse: result.data,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    return {
      status: result.status,
      body: result.data
    };
  }

  // Refund only when the provider clearly reports a failure.
  if (result.status === 409 || result.status === 400) {
    await refundWallet(
      uid,
      created.record.chargedAmount,
      `wick_refund_${requestKey}`,
      {
        provider: "wickspend",
        requestKey,
        reason: "Confirmed purchase failure"
      }
    );

    await created.ref.update({
      status: "failed_refunded",
      providerResponse: result.data,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
  } else {
    await created.ref.update({
      status: "provider_status_unknown",
      providerResponse: result.data
    });

    return {
      status: 202,
      body: {
        status: "provider_status_unknown",
        request_key: requestKey
      }
    };
  }

  return {
    status: result.status,
    body: result.data
  };
}

// Number purchase
app.post(
  "/api/wickspend/numbers/buy",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const {
        country_code,
        service_code,
        provider_id,
        request_key,
        offer_id
      } = req.body;

      const key = makeRequestKey(request_key);

      if (
        !validText(country_code, 10) ||
        !validText(service_code, 100) ||
        !validText(provider_id, 100) ||
        !key
      ) {
        return res.status(400).json({
          error: "country_code, service_code, provider_id and a request_key of at least 8 characters are required"
        });
      }

      const priceSnapshot = await db()
        .ref(`settings/pricing/wickspend/numbers/${offer_id || service_code}`)
        .get();

      const price = safeNumber(
        priceSnapshot.child("price").val()
      );

      const result = await completeWickPurchase({
        uid: req.user.uid,
        kind: "number",
        requestKey: key,
        payload: {
          country_code,
          service_code,
          provider_id,
          request_key: key
        },
        price,
        endpoint: "/numbers/buy"
      });

      res.status(result.status).json(result.body);
    } catch (error) {
      if (error.message === "INSUFFICIENT_BALANCE") {
        return res.status(402).json({
          error: "Insufficient CPOVERIFY wallet balance"
        });
      }

      errorResponse(res, error);
    }
  }
);

// Long rental purchase
app.post(
  "/api/wickspend/rentals/buy",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const {
        service_code,
        duration_minutes,
        request_key,
        country_code
      } = req.body;

      const key = makeRequestKey(request_key);
      const duration = Number(duration_minutes);

      const allowedDurations = [
        1440,
        4320,
        10080,
        20160,
        43200
      ];

      if (
        !validText(service_code, 100) ||
        !key ||
        !allowedDurations.includes(duration)
      ) {
        return res.status(400).json({
          error: "Invalid rental service, duration or request key"
        });
      }

      const priceSnapshot = await db()
        .ref(
          `settings/pricing/wickspend/rentals/${service_code}_${duration}`
        )
        .get();

      const price = safeNumber(
        priceSnapshot.child("price").val()
      );

      const payload = {
        service_code,
        duration_minutes: duration,
        request_key: key
      };

      if (validText(country_code, 10)) {
        payload.country_code = country_code;
      }

      const result = await completeWickPurchase({
        uid: req.user.uid,
        kind: "rental",
        requestKey: key,
        payload,
        price,
        endpoint: "/rentals/buy"
      });

      res.status(result.status).json(result.body);
    } catch (error) {
      if (error.message === "INSUFFICIENT_BALANCE") {
        return res.status(402).json({
          error: "Insufficient CPOVERIFY wallet balance"
        });
      }

      errorResponse(res, error);
    }
  }
);

// Customer order history
app.get(
  "/api/wickspend/orders",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const snapshot = await db()
        .ref(`users/${req.user.uid}/wickspendRequests`)
        .get();

      res.json(snapshot.val() || {});
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

// Number status — only allow references recorded for this user.
app.get(
  "/api/wickspend/numbers/status",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const reference = String(req.query.reference || "");

      if (!validText(reference, 150)) {
        return res.status(400).json({
          error: "A valid reference is required"
        });
      }

      const snapshot = await db()
        .ref(`users/${req.user.uid}/wickspendRequests`)
        .get();

      const orders = snapshot.val() || {};
      const owned = Object.values(orders).some(order =>
        order &&
        order.kind === "number" &&
        order.providerResponse &&
        String(
          order.providerResponse.reference ||
          order.providerResponse.order?.reference ||
          ""
        ) === reference
      );

      if (!owned) {
        return res.status(404).json({
          error: "Number order not found"
        });
      }

      const url = new URL(`${WICKSPEND_URL}/numbers/status`);
      url.searchParams.set("reference", reference);

      const result = await getJson(url, wickHeaders());
      res.status(result.ok ? 200 : result.status).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// Rental status — only allow references recorded for this user.
app.get(
  "/api/wickspend/rentals/order",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const reference = String(req.query.reference || "");

      if (!validText(reference, 150)) {
        return res.status(400).json({
          error: "A valid reference is required"
        });
      }

      const snapshot = await db()
        .ref(`users/${req.user.uid}/wickspendRequests`)
        .get();

      const orders = snapshot.val() || {};
      const owned = Object.values(orders).some(order =>
        order &&
        order.kind === "rental" &&
        order.providerResponse &&
        String(
          order.providerResponse.reference ||
          order.providerResponse.order?.reference ||
          ""
        ) === reference
      );

      if (!owned) {
        return res.status(404).json({
          error: "Rental order not found"
        });
      }

      const url = new URL(`${WICKSPEND_URL}/rentals/order`);
      url.searchParams.set("reference", reference);

      const result = await getJson(url, wickHeaders());
      res.status(result.ok ? 200 : result.status).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// Admin can inspect provider order lists.
app.get(
  "/api/admin/wickspend/numbers/orders",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await getJson(
        `${WICKSPEND_URL}/numbers/orders`,
        wickHeaders()
      );

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.get(
  "/api/admin/wickspend/rentals/orders",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await getJson(
        `${WICKSPEND_URL}/rentals/orders`,
        wickHeaders()
      );

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// Cancellation helper.
// The CPOVERIFY wallet is credited only after WickSpend
// returns a successful, confirmed cancellation.
async function cancelWickOrder(uid, kind, reference) {
  const snapshot = await db()
    .ref(`users/${uid}/wickspendRequests`)
    .get();

  const orders = snapshot.val() || {};

  const entry = Object.entries(orders).find(([, order]) =>
    order &&
    order.kind === kind &&
    order.providerResponse &&
    String(
      order.providerResponse.reference ||
      order.providerResponse.order?.reference ||
      ""
    ) === reference
  );

  if (!entry) {
    return {
      status: 404,
      body: { error: "Order not found" }
    };
  }

  const [key, order] = entry;

  if (order.status === "refunded") {
    return {
      status: 200,
      body: { success: true, already_refunded: true }
    };
  }

  const endpoint = kind === "number"
    ? "/numbers/cancel"
    : "/rentals/cancel";

  const result = await postJson(
    `${WICKSPEND_URL}${endpoint}`,
    { reference },
    wickHeaders()
  );

  if (result.status === 202) {
    return {
      status: 202,
      body: {
        status: "cancellation_status_unknown",
        provider: result.data
      }
    };
  }

  if (!result.ok) {
    return {
      status: result.status,
      body: result.data
    };
  }

  await refundWallet(
    uid,
    safeNumber(order.chargedAmount),
    `wick_cancel_refund_${key}`,
    {
      provider: "wickspend",
      kind,
      reference
    }
  );

  await db()
    .ref(`users/${uid}/wickspendRequests/${key}`)
    .update({
      status: "refunded",
      cancellationResponse: result.data,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

  return {
    status: 200,
    body: result.data
  };
}

app.post(
  "/api/wickspend/numbers/cancel",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const reference = String(req.body.reference || "");

      if (!validText(reference, 150)) {
        return res.status(400).json({
          error: "Reference is required"
        });
      }

      const result = await cancelWickOrder(
        req.user.uid,
        "number",
        reference
      );

      res.status(result.status).json(result.body);
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.post(
  "/api/wickspend/rentals/cancel",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const reference = String(req.body.reference || "");

      if (!validText(reference, 150)) {
        return res.status(400).json({
          error: "Reference is required"
        });
      }

      const result = await cancelWickOrder(
        req.user.uid,
        "rental",
        reference
      );

      res.status(result.status).json(result.body);
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

// --------------------------------------------------
// MYSMM — ACCOUNT BOOSTING
// --------------------------------------------------

app.get(
  "/api/mysmm/services",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const url = mySmmUrl("services");

      const result = await getJson(url);

      if (!result.ok) {
        return res.status(502).json({
          error: "MySMM services request failed"
        });
      }

      res.json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.get(
  "/api/admin/mysmm/balance",
  verifyFirebaseUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const url = mySmmUrl("balance");
      const result = await getJson(url);

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.post(
  "/api/mysmm/order",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      if (!["per1000", "perunit"].includes(MYSMM_RATE_UNIT)) {
        return res.status(503).json({
          error: "MySMM order placement is disabled until MYSMM_RATE_UNIT is confirmed as per1000 or perunit"
        });
      }

      const { service, link, quantity, request_key } = req.body;
      const key = makeRequestKey(request_key);
      const qty = Number(quantity);

      if (
        !validText(String(service || ""), 80) ||
        !validText(link, 2000) ||
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        !key
      ) {
        return res.status(400).json({
          error: "Invalid service, link, quantity or request_key"
        });
      }

      let target;

      try {
        target = new URL(link);
      } catch {
        return res.status(400).json({
          error: "A valid link is required"
        });
      }

      if (!["http:", "https:"].includes(target.protocol)) {
        return res.status(400).json({
          error: "Only HTTP and HTTPS links are accepted"
        });
      }

      const existingRef = db().ref(
        `users/${req.user.uid}/mysmmRequests/${key}`
      );

      const existing = await existingRef.get();

      if (existing.exists()) {
        return res.json({
          duplicate: true,
          order: existing.val()
        });
      }

      // Fetch trusted provider service details.
      const servicesResult = await getJson(mySmmUrl("services"));

      if (!servicesResult.ok || !Array.isArray(servicesResult.data)) {
        return res.status(502).json({
          error: "Unable to verify MySMM service"
        });
      }

      const selected = servicesResult.data.find(
        item => String(item.service) === String(service)
      );

      if (!selected) {
        return res.status(404).json({
          error: "MySMM service not found"
        });
      }

      const min = Number(selected.min);
      const max = Number(selected.max);
      const rate = Number(selected.rate);

      if (
        !Number.isFinite(rate) ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        qty < min ||
        qty > max
      ) {
        return res.status(400).json({
          error: "Quantity is outside the provider's allowed range"
        });
      }

      const baseCost = MYSMM_RATE_UNIT === "per1000"
        ? rate * qty / 1000
        : rate * qty;

      const chargeNGN = Math.ceil(
        baseCost *
        USD_TO_NGN_RATE *
        (1 + BOOST_MARKUP_PERCENT / 100) *
        100
      );

      if (!Number.isSafeInteger(chargeNGN) || chargeNGN <= 0) {
        return res.status(400).json({
          error: "Unable to calculate order price"
        });
      }

      await changeWallet(
        req.user.uid,
        chargeNGN,
        `mysmm_${key}`,
        "debit",
        {
          provider: "mysmm",
          service,
          quantity: qty,
          requestKey: key
        }
      );

      await existingRef.set({
        provider: "mysmm",
        service: String(service),
        link,
        quantity: qty,
        chargedAmount: chargeNGN,
        status: "processing",
        requestKey: key,
        createdAt: admin.database.ServerValue.TIMESTAMP
      });

      const addUrl = mySmmUrl("add");

      const form = new URLSearchParams({
        service: String(service),
        link,
        quantity: String(qty)
      });

      const result = await providerRequest(addUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      });

      if (
        result.ok &&
        result.data &&
        result.data.order !== undefined
      ) {
        await existingRef.update({
          providerOrderId: String(result.data.order),
          status: "submitted",
          providerResponse: result.data,
          updatedAt: admin.database.ServerValue.TIMESTAMP
        });

        return res.json({
          success: true,
          order: result.data.order,
          chargedAmount: chargeNGN / 100
        });
      }

      // A clear provider error is refundable.
      // Network uncertainty is not.
      if (result.ok && result.data && result.data.error) {
        await refundWallet(
          req.user.uid,
          chargeNGN,
          `mysmm_refund_${key}`,
          {
            provider: "mysmm",
            reason: "Provider rejected order"
          }
        );

        await existingRef.update({
          status: "failed_refunded",
          providerResponse: result.data
        });

        return res.status(409).json({
          error: "MySMM rejected the order",
          provider: result.data
        });
      }

      await existingRef.update({
        status: "provider_status_unknown",
        providerResponse: result.data
      });

      res.status(202).json({
        status: "provider_status_unknown",
        request_key: key,
        message: "Do not submit this purchase again with a new request key."
      });
    } catch (error) {
      if (error.message === "INSUFFICIENT_BALANCE") {
        return res.status(402).json({
          error: "Insufficient CPOVERIFY wallet balance"
        });
      }

      errorResponse(res, error);
    }
  }
);

app.get(
  "/api/mysmm/orders",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const snapshot = await db()
        .ref(`users/${req.user.uid}/mysmmRequests`)
        .get();

      res.json(snapshot.val() || {});
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.get(
  "/api/mysmm/status",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const key = String(req.query.request_key || "");

      if (!validText(key, 120)) {
        return res.status(400).json({
          error: "request_key is required"
        });
      }

      const ref = db().ref(
        `users/${req.user.uid}/mysmmRequests/${key}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return res.status(404).json({
          error: "Order not found"
        });
      }

      const order = snapshot.val();

      if (!order.providerOrderId) {
        return res.status(202).json({
          status: order.status
        });
      }

      const url = mySmmUrl("status");
      url.searchParams.set("order", order.providerOrderId);

      const result = await getJson(url);

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

app.post(
  "/api/mysmm/cancel",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const key = String(req.body.request_key || "");

      if (!validText(key, 120)) {
        return res.status(400).json({
          error: "request_key is required"
        });
      }

      const ref = db().ref(
        `users/${req.user.uid}/mysmmRequests/${key}`
      );

      const snapshot = await ref.get();

      if (!snapshot.exists()) {
        return res.status(404).json({
          error: "Order not found"
        });
      }

      const order = snapshot.val();

      if (!order.providerOrderId) {
        return res.status(409).json({
          error: "This order has no confirmed provider order ID"
        });
      }

      const url = mySmmUrl("cancel");

      const form = new URLSearchParams({
        order: String(order.providerOrderId)
      });

      const result = await providerRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      });

      if (!result.ok) {
        return res.status(502).json(result.data);
      }

      await ref.update({
        cancelResponse: result.data,
        cancelRequestedAt: admin.database.ServerValue.TIMESTAMP
      });

      // MySMM cancellation response does not specify the amount
      // actually refunded. Therefore no automatic wallet credit.
      res.json({
        success: true,
        provider: result.data,
        message: "Cancellation response received. Wallet refund requires confirmed provider refund details."
      });
    } catch (error) {
      errorResponse(res, error);
    }
  }
);

app.post(
  "/api/mysmm/refill",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const key = String(req.body.request_key || "");

      const snapshot = await db()
        .ref(`users/${req.user.uid}/mysmmRequests/${key}`)
        .get();

      if (!snapshot.exists()) {
        return res.status(404).json({
          error: "Order not found"
        });
      }

      const order = snapshot.val();

      if (!order.providerOrderId) {
        return res.status(409).json({
          error: "Provider order ID is unavailable"
        });
      }

      const url = mySmmUrl("refill");

      const form = new URLSearchParams({
        order: String(order.providerOrderId)
      });

      const result = await providerRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      });

      res.status(result.ok ? 200 : 502).json(result.data);
    } catch (error) {
      errorResponse(res, error, 502);
    }
  }
);

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`CPOVERIFY backend running on port ${PORT}`);
});
