
const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_ORIGIN = "https://preshwy122.github.io";

const WICKSPEND_URL =
  (process.env.WICKSPEND_BASE_URL || "https://wickspend.com/api/v1")
    .replace(/\/+$/, "");

const SAMEEHA_URL =
  "https://sameehasocialhub.com/api/v1";

const MYSMM_URL =
  (process.env.MYSMM_BASE_URL || "https://mysmm.co/api/v2")
    .replace(/\/+$/, "");

const USD_TO_NGN_RATE =
  Number(process.env.USD_TO_NGN_RATE || 1400);

const BOOST_MARKUP_PERCENT =
  Number(process.env.BOOST_MARKUP_PERCENT || 20);

// --------------------------------------------------
// CORS AND BODY PARSING
// --------------------------------------------------

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
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
// FIREBASE ADMIN INITIALIZATION
// --------------------------------------------------

if (!admin.apps.length) {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : undefined
  };

  if (
    serviceAccount.projectId &&
    serviceAccount.clientEmail &&
    serviceAccount.privateKey
  ) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

function database() {
  if (!admin.apps.length) {
    throw new Error("Firebase backend is not configured.");
  }

  return admin.database();
}

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function cleanString(value, maxLength = 300) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function validMoney(value) {
  const amount = Number(value);

  return Number.isFinite(amount) &&
    amount >= 0 &&
    Math.round(amount * 100) / 100 === amount;
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function safeRequestKey(value) {
  const key = cleanString(value, 100);

  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) {
    throw new Error(
      "A valid request_key containing 8–100 letters, numbers, underscores or hyphens is required."
    );
  }

  return key;
}

function providerErrorMessage(data, fallback) {
  if (!data) return fallback;

  return cleanString(
    data.error ||
    data.message ||
    data.description ||
    data.detail,
    500
  ) || fallback;
}

async function readProviderResponse(response) {
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function providerFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000)
  });

  return readProviderResponse(response);
}

function sendProviderError(res, result, fallback) {
  console.error("Provider error:", result.status, result.data);

  return res.status(502).json({
    error: providerErrorMessage(result.data, fallback),
    providerStatus: result.status
  });
}

function extractReference(data) {
  if (!data || typeof data !== "object") return null;

  const possible = [
    data.reference,
    data.order_reference,
    data.orderReference,
    data.order_id,
    data.orderId,
    data.id,
    data.data?.reference,
    data.data?.order_reference,
    data.data?.order_id,
    data.data?.id
  ];

  const found = possible.find(
    value => typeof value === "string" || typeof value === "number"
  );

  return found === undefined ? null : String(found);
}

function confirmedProviderSuccess(data) {
  if (!data || typeof data !== "object") return false;

  if (data.success === true || data.cancelled === true) return true;

  const status = String(
    data.status || data.state || ""
  ).toLowerCase();

  return [
    "cancelled",
    "canceled",
    "refunded",
    "success",
    "completed"
  ].includes(status);
}

// --------------------------------------------------
// FIREBASE AUTHENTICATION
// --------------------------------------------------

async function verifyFirebaseUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    if (!admin.apps.length) {
      return res.status(503).json({
        error: "Firebase backend is not configured."
      });
    }

    const token = header.slice(7);
    req.user = await admin.auth().verifyIdToken(token);

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired authentication token."
    });
  }
}

function verifyAdmin(req, res, next) {
  const adminUID = process.env.ADMIN_UID;

  if (!adminUID) {
    return res.status(503).json({
      error: "ADMIN_UID is not configured in Render."
    });
  }

  if (req.user.uid !== adminUID) {
    return res.status(403).json({
      error: "Admin access required."
    });
  }

  next();
}

const authenticated = verifyFirebaseUser;
const administrator = [verifyFirebaseUser, verifyAdmin];

// --------------------------------------------------
// HEALTH CHECK AND USER INFORMATION
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "CPOVERIFY Backend",
    status: "running",
    providers: {
      wickspend: "Numbers only",
      sameeha: "Account Logs",
      mysmm: "Account Boosting"
    }
  });
});

app.get("/api/me", authenticated, (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email || null
  });
});

app.get("/api/admin/check", ...administrator, (req, res) => {
  res.json({
    admin: true,
    message: "Admin access verified."
  });
});

// --------------------------------------------------
// WALLET
//
// Wallet balance is stored as ordinary naira amounts.
// Example: 5000 means ₦5,000.
// Transactions and balance changes are committed
// together inside the wallet transaction.
// --------------------------------------------------

async function changeWallet(uid, amount, transactionId, type, details = {}) {
  amount = money(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid wallet amount.");
  }

  const walletRef = database().ref(`users/${uid}/wallet`);

  const result = await walletRef.transaction(wallet => {
    wallet = wallet || {};

    const transactions = wallet.transactions || {};

    // Prevent the same debit/refund from being applied twice.
    if (transactions[transactionId]) {
      return;
    }

    const currentBalance = Number(wallet.balance || 0);

    if (!Number.isFinite(currentBalance) || currentBalance < 0) {
      return;
    }

    if (type === "debit" && currentBalance < amount) {
      return;
    }

    const newBalance = type === "debit"
      ? money(currentBalance - amount)
      : money(currentBalance + amount);

    wallet.balance = newBalance;

    transactions[transactionId] = {
      id: transactionId,
      type,
      amount,
      currency: "NGN",
      description: cleanString(details.description || type, 200),
      reference: cleanString(details.reference || "", 150),
      createdAt: Date.now()
    };

    wallet.transactions = transactions;

    return wallet;
  });

  if (!result.committed) {
    const current = await walletRef.once("value");
    const wallet = current.val() || {};

    if ((wallet.transactions || {})[transactionId]) {
      return {
        alreadyProcessed: true,
        balance: Number(wallet.balance || 0)
      };
    }

    if (
      type === "debit" &&
      Number(wallet.balance || 0) < amount
    ) {
      throw new Error("Insufficient wallet balance.");
    }

    throw new Error("Wallet transaction could not be completed.");
  }

  return {
    alreadyProcessed: false,
    balance: Number(result.snapshot.val().balance || 0)
  };
}

async function debitWallet(uid, amount, requestKey, description) {
  return changeWallet(
    uid,
    amount,
    `debit_${requestKey}`,
    "debit",
    { description }
  );
}

async function refundWallet(uid, amount, requestKey, description) {
  return changeWallet(
    uid,
    amount,
    `refund_${requestKey}`,
    "refund",
    { description }
  );
}

app.get("/api/wallet", authenticated, async (req, res) => {
  try {
    const snapshot = await database()
      .ref(`users/${req.user.uid}/wallet/balance`)
      .once("value");

    const balance = snapshot.exists()
      ? Number(snapshot.val())
      : 0;

    if (!Number.isFinite(balance) || balance < 0) {
      return res.status(500).json({
        error: "Wallet balance data is invalid."
      });
    }

    res.json({
      balance,
      currency: "NGN"
    });
  } catch (error) {
    console.error("Wallet read error:", error.message);

    res.status(500).json({
      error: "Unable to retrieve wallet balance."
    });
  }
});

// Admin manually credits a user's wallet.
// Supply the user's Firebase UID and amount in naira.
app.post(
  "/api/admin/wallet/credit",
  ...administrator,
  async (req, res) => {
    try {
      const uid = cleanString(req.body.uid, 150);
      const amount = Number(req.body.amount);
      const description = cleanString(
        req.body.description || "Admin wallet credit",
        200
      );

      if (!uid || !validMoney(amount) || amount <= 0) {
        return res.status(400).json({
          error: "A valid user UID and naira amount are required."
        });
      }

      const creditId = makeId();

      const result = await changeWallet(
        uid,
        amount,
        `admin_credit_${creditId}`,
        "credit",
        { description }
      );

      res.json({
        success: true,
        balance: result.balance,
        currency: "NGN"
      });
    } catch (error) {
      console.error("Admin credit error:", error.message);

      res.status(500).json({
        error: error.message || "Unable to credit wallet."
      });
    }
  }
);

// --------------------------------------------------
// PURCHASE REQUEST RESERVATION
//
// A request key is reserved before contacting a provider.
// A repeated request key will never start a second purchase.
// --------------------------------------------------

async function reservePurchase(uid, requestKey, record) {
  const ref = database().ref(
    `users/${uid}/purchaseRequests/${requestKey}`
  );

  const result = await ref.transaction(existing => {
    if (existing) return;

    return {
      ...record,
      requestKey,
      createdAt: Date.now(),
      status: "reserved"
    };
  });

  if (!result.committed) {
    return {
      created: false,
      record: result.snapshot.val()
    };
  }

  return {
    created: true,
    record: result.snapshot.val()
  };
}

async function updatePurchase(uid, requestKey, changes) {
  await database()
    .ref(`users/${uid}/purchaseRequests/${requestKey}`)
    .update({
      ...changes,
      updatedAt: Date.now()
    });
}

// --------------------------------------------------
// WICKSPEND: NUMBERS ONLY
// Long rentals are intentionally not included.
// --------------------------------------------------

function wickspendHeaders() {
  if (!process.env.WICKSPEND_API_KEY) {
    throw new Error("WICKSPEND_API_KEY is not configured.");
  }

  return {
    "X-API-Key": process.env.WICKSPEND_API_KEY,
    "Content-Type": "application/json"
  };
}

async function wickspendGet(path) {
  return providerFetch(WICKSPEND_URL + path, {
    method: "GET",
    headers: wickspendHeaders()
  });
}

async function wickspendPost(path, body) {
  return providerFetch(WICKSPEND_URL + path, {
    method: "POST",
    headers: wickspendHeaders(),
    body: JSON.stringify(body)
  });
}

// Admin: inspect WickSpend's live number catalogue.
// The raw provider response is returned for admin review.
app.get(
  "/api/admin/wickspend/provider/numbers/catalog",
  ...administrator,
  async (req, res) => {
    try {
      const result = await wickspendGet("/numbers/catalog");

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to load WickSpend number catalogue."
        );
      }

      res.json(result.data);
    } catch (error) {
      console.error("WickSpend catalogue error:", error.message);

      res.status(500).json({
        error: error.message || "WickSpend connection failed."
      });
    }
  }
);

// Admin: inspect WickSpend wallet balance.
app.get(
  "/api/admin/wickspend/provider/balance",
  ...administrator,
  async (req, res) => {
    try {
      const result = await wickspendGet("/balance");

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to retrieve WickSpend balance."
        );
      }

      res.json(result.data);
    } catch (error) {
      res.status(500).json({
        error: error.message || "WickSpend connection failed."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN-MANAGED WICKSPEND NUMBER OFFERS
//
// Firebase location:
// settings/wickspendOffers/numbers/{offerId}
//
// Admin sets provider identifiers and retail price.
// Customers cannot submit their own provider IDs or price.
// --------------------------------------------------

function validateNumberOffer(body) {
  const offer = {
    country: cleanString(body.country, 100),
    country_code: cleanString(body.country_code, 30),
    service: cleanString(body.service, 120),
    service_code: cleanString(body.service_code, 100),
    provider_id: cleanString(String(body.provider_id || ""), 150),
    offer_id: cleanString(String(body.offer_id || ""), 150),
    price: Number(body.price),
    active: body.active !== false
  };

  if (
    !offer.country ||
    !offer.country_code ||
    !offer.service ||
    !offer.service_code ||
    !offer.provider_id ||
    !validMoney(offer.price) ||
    offer.price <= 0
  ) {
    throw new Error(
      "Country, country code, service, service code, provider ID and a valid naira price are required."
    );
  }

  return offer;
}

app.get(
  "/api/admin/wickspend/offers/numbers",
  ...administrator,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref("settings/wickspendOffers/numbers")
        .once("value");

      const offers = snapshot.val() || {};

      res.json({
        offers: Object.entries(offers).map(([id, offer]) => ({
          id,
          ...offer
        }))
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load number offers."
      });
    }
  }
);

app.post(
  "/api/admin/wickspend/offers/numbers",
  ...administrator,
  async (req, res) => {
    try {
      const offer = validateNumberOffer(req.body || {});
      const ref = database()
        .ref("settings/wickspendOffers/numbers")
        .push();

      await ref.set({
        ...offer,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      res.status(201).json({
        success: true,
        id: ref.key,
        offer
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.put(
  "/api/admin/wickspend/offers/numbers/:id",
  ...administrator,
  async (req, res) => {
    try {
      const id = cleanString(req.params.id, 150);

      if (!id || id.includes(".") || id.includes("#") ||
          id.includes("$") || id.includes("[") || id.includes("]") ||
          id.includes("/")) {
        return res.status(400).json({
          error: "Invalid offer ID."
        });
      }

      const ref = database().ref(
        `settings/wickspendOffers/numbers/${id}`
      );

      const existing = await ref.once("value");

      if (!existing.exists()) {
        return res.status(404).json({
          error: "Offer not found."
        });
      }

      const offer = validateNumberOffer(req.body || {});

      await ref.update({
        ...offer,
        updatedAt: Date.now()
      });

      res.json({
        success: true,
        id,
        offer
      });
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.delete(
  "/api/admin/wickspend/offers/numbers/:id",
  ...administrator,
  async (req, res) => {
    try {
      const id = cleanString(req.params.id, 150);

      await database()
        .ref(`settings/wickspendOffers/numbers/${id}`)
        .remove();

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: "Unable to delete offer."
      });
    }
  }
);

// Customer catalogue: active admin-configured offers only.
app.get(
  "/api/wickspend/numbers/catalog",
  authenticated,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref("settings/wickspendOffers/numbers")
        .once("value");

      const offers = snapshot.val() || {};

      const activeOffers = Object.entries(offers)
        .filter(([, offer]) =>
          offer &&
          offer.active === true &&
          validMoney(Number(offer.price))
        )
        .map(([id, offer]) => ({
          id,
          country: offer.country,
          country_code: offer.country_code,
          service: offer.service,
          price: Number(offer.price),
          currency: "NGN"
        }));

      res.json({ offers: activeOffers });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load available numbers."
      });
    }
  }
);

// --------------------------------------------------
// WICKSPEND NUMBER PURCHASE
// Customer sends only offerId and request_key.
// Provider IDs and selling price come from Firebase.
// --------------------------------------------------

app.post(
  "/api/wickspend/numbers/buy",
  authenticated,
  async (req, res) => {
    const uid = req.user.uid;
    let requestKey;

    try {
      requestKey = safeRequestKey(req.body.request_key);

      const offerId = cleanString(req.body.offerId, 150);

      if (!offerId || /[.#$\[\]/]/.test(offerId)) {
        return res.status(400).json({
          error: "A valid offerId is required."
        });
      }

      const offerSnapshot = await database()
        .ref(`settings/wickspendOffers/numbers/${offerId}`)
        .once("value");

      const offer = offerSnapshot.val();

      if (!offer || offer.active !== true) {
        return res.status(404).json({
          error: "This number offer is unavailable."
        });
      }

      const price = Number(offer.price);

      if (!validMoney(price) || price <= 0) {
        return res.status(500).json({
          error: "The offer has an invalid selling price."
        });
      }

      const reservation = await reservePurchase(
        uid,
        requestKey,
        {
          provider: "wickspend",
          product: "number",
          offerId,
          price,
          currency: "NGN"
        }
      );

      if (!reservation.created) {
        return res.status(409).json({
          error: "This purchase request has already been submitted. Do not create a new request key to repeat it.",
          request: reservation.record
        });
      }

      const orderRef = database()
        .ref(`users/${uid}/wickspendOrders/${requestKey}`);

      await orderRef.set({
        provider: "wickspend",
        type: "number",
        offerId,
        country: offer.country,
        service: offer.service,
        price,
        currency: "NGN",
        status: "reserved",
        createdAt: Date.now()
      });

      try {
        const debit = await debitWallet(
          uid,
          price,
          `wick_${requestKey}`,
          `WickSpend ${offer.service} number`
        );

        await updatePurchase(uid, requestKey, {
          status: "payment_debited",
          balanceAfter: debit.balance
        });

        await orderRef.update({
          status: "submitting",
          balanceAfter: debit.balance
        });
      } catch (error) {
        await updatePurchase(uid, requestKey, {
          status: "payment_failed",
          error: error.message
        });

        await orderRef.update({
          status: "payment_failed"
        });

        return res.status(400).json({
          error: error.message
        });
      }

      let result;

      try {
        result = await wickspendPost("/numbers/buy", {
          country_code: offer.country_code,
          service_code: offer.service_code,
          provider_id: offer.provider_id,
          request_key: requestKey
        });
      } catch (error) {
        // A timeout does not prove that the provider failed.
        await updatePurchase(uid, requestKey, {
          status: "provider_status_unknown",
          error: "Provider response was not received."
        });

        await orderRef.update({
          status: "provider_status_unknown"
        });

        return res.status(202).json({
          status: "provider_status_unknown",
          message: "Your purchase is being checked. Do not submit it again."
        });
      }

      const reference = extractReference(result.data);

      if (result.ok) {
        const providerStatus = result.status === 202
          ? "processing"
          : "submitted";

        await updatePurchase(uid, requestKey, {
          status: providerStatus,
          providerReference: reference,
          providerResponse: result.data
        });

        await orderRef.update({
          status: providerStatus,
          reference,
          providerResponse: result.data,
          updatedAt: Date.now()
        });

        return res.status(result.status === 202 ? 202 : 200).json({
          success: true,
          status: providerStatus,
          reference,
          request_key: requestKey,
          message: "Number purchase submitted."
        });
      }

      // Refund only on a clear provider-side 4xx rejection.
      if (result.status >= 400 && result.status < 500) {
        await refundWallet(
          uid,
          price,
          `wick_${requestKey}`,
          "WickSpend number purchase rejected"
        );

        await updatePurchase(uid, requestKey, {
          status: "provider_failed_refunded",
          providerResponse: result.data
        });

        await orderRef.update({
          status: "provider_failed_refunded",
          providerResponse: result.data
        });

        return res.status(502).json({
          error: providerErrorMessage(
            result.data,
            "The provider rejected the purchase. Your wallet has been refunded."
          ),
          refunded: true
        });
      }

      // Server errors and ambiguous responses are not automatically refunded.
      await updatePurchase(uid, requestKey, {
        status: "provider_status_unknown",
        providerResponse: result.data
      });

      await orderRef.update({
        status: "provider_status_unknown",
        providerResponse: result.data
      });

      return res.status(202).json({
        status: "provider_status_unknown",
        message: "The provider response is uncertain. Your request is saved for checking."
      });
    } catch (error) {
      console.error("WickSpend purchase error:", error.message);

      res.status(400).json({
        error: error.message || "Unable to submit number purchase."
      });
    }
  }
);

// --------------------------------------------------
// WICKSPEND ORDER HISTORY AND STATUS
// --------------------------------------------------

app.get(
  "/api/wickspend/numbers/orders",
  authenticated,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref(`users/${req.user.uid}/wickspendOrders`)
        .once("value");

      const orders = snapshot.val() || {};

      res.json({
        orders: Object.entries(orders).map(([requestKey, order]) => ({
          requestKey,
          ...order
        }))
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load your number orders."
      });
    }
  }
);

app.get(
  "/api/wickspend/numbers/status",
  authenticated,
  async (req, res) => {
    try {
      const reference = cleanString(req.query.reference, 200);

      if (!reference) {
        return res.status(400).json({
          error: "Order reference is required."
        });
      }

      const snapshot = await database()
        .ref(`users/${req.user.uid}/wickspendOrders`)
        .once("value");

      const orders = snapshot.val() || {};

      const match = Object.entries(orders).find(
        ([, order]) => order.reference === reference
      );

      if (!match) {
        return res.status(404).json({
          error: "Order not found."
        });
      }

      const result = await wickspendGet(
        "/numbers/status?reference=" + encodeURIComponent(reference)
      );

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to check number status."
        );
      }

      const [requestKey, order] = match;

      await database()
        .ref(`users/${req.user.uid}/wickspendOrders/${requestKey}`)
        .update({
          latestStatus: result.data,
          checkedAt: Date.now()
        });

      res.json({
        order,
        status: result.data
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to check order status."
      });
    }
  }
);

// --------------------------------------------------
// WICKSPEND NUMBER CANCELLATION
//
// The provider must explicitly confirm cancellation
// before the customer's wallet is credited.
// --------------------------------------------------

app.post(
  "/api/wickspend/numbers/cancel",
  authenticated,
  async (req, res) => {
    try {
      const reference = cleanString(req.body.reference, 200);

      if (!reference) {
        return res.status(400).json({
          error: "Order reference is required."
        });
      }

      const ordersRef = database()
        .ref(`users/${req.user.uid}/wickspendOrders`);

      const snapshot = await ordersRef.once("value");
      const orders = snapshot.val() || {};

      const match = Object.entries(orders).find(
        ([, order]) => order.reference === reference
      );

      if (!match) {
        return res.status(404).json({
          error: "Order not found."
        });
      }

      const [requestKey, order] = match;

      if (order.status === "cancelled_refunded") {
        return res.json({
          success: true,
          refunded: true,
          message: "This order has already been refunded."
        });
      }

      const result = await wickspendPost("/numbers/cancel", {
        reference
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Cancellation could not be confirmed."
        );
      }

      if (!confirmedProviderSuccess(result.data)) {
        await ordersRef.child(requestKey).update({
          cancellationStatus: "awaiting_confirmation",
          cancellationResponse: result.data,
          updatedAt: Date.now()
        });

        return res.status(202).json({
          status: "awaiting_confirmation",
          message: "The provider has not yet confirmed cancellation. No refund has been issued."
        });
      }

      await refundWallet(
        req.user.uid,
        Number(order.price),
        `wick_${requestKey}`,
        "WickSpend number cancellation refund"
      );

      await ordersRef.child(requestKey).update({
        status: "cancelled_refunded",
        cancellationResponse: result.data,
        cancelledAt: Date.now()
      });

      await updatePurchase(req.user.uid, requestKey, {
        status: "cancelled_refunded"
      });

      res.json({
        success: true,
        refunded: true,
        amount: Number(order.price),
        currency: "NGN"
      });
    } catch (error) {
      console.error("WickSpend cancellation error:", error.message);

      res.status(500).json({
        error: error.message || "Unable to cancel number."
      });
    }
  }
);

// --------------------------------------------------
// SAMEEHA SOCIAL HUB: ACCOUNT LOGS
// --------------------------------------------------

async function sameehaGet(path) {
  if (!process.env.SAMEEHA_API_KEY) {
    throw new Error("SAMEEHA_API_KEY is not configured.");
  }

  return providerFetch(SAMEEHA_URL + path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.SAMEEHA_API_KEY}`
    }
  });
}

app.get(
  "/api/provider/categories",
  authenticated,
  async (req, res) => {
    try {
      const result = await sameehaGet("/categories");

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to load Account Logs categories."
        );
      }

      res.json(result.data);
    } catch (error) {
      console.error("Sameeha categories error:", error.message);

      res.status(500).json({
        error: "Sameeha provider connection failed."
      });
    }
  }
);

// Existing frontend app.js uses this route.
app.get(
  "/api/provider/products",
  async (req, res) => {
    try {
      const result = await sameehaGet("/products");

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to load Account Logs listings."
        );
      }

      res.json(result.data);
    } catch (error) {
      console.error("Sameeha products error:", error.message);

      res.status(500).json({
        error: "Account Logs provider connection failed."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN-MANAGED MANUAL ACCOUNT LOG LISTINGS
// --------------------------------------------------

app.get(
  "/api/admin/account-logs/manual",
  ...administrator,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref("settings/accountLogs/manual")
        .once("value");

      const listings = snapshot.val() || {};

      res.json({
        listings: Object.entries(listings).map(([id, item]) => ({
          id,
          ...item
        }))
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load manual listings."
      });
    }
  }
);

app.post(
  "/api/admin/account-logs/manual",
  ...administrator,
  async (req, res) => {
    try {
      const title = cleanString(req.body.title, 150);
      const description = cleanString(req.body.description, 1000);
      const price = Number(req.body.price);

      if (!title || !validMoney(price) || price <= 0) {
        return res.status(400).json({
          error: "A title and valid naira price are required."
        });
      }

      const ref = database()
        .ref("settings/accountLogs/manual")
        .push();

      const listing = {
        title,
        description,
        price,
        active: req.body.active !== false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await ref.set(listing);

      res.status(201).json({
        success: true,
        id: ref.key,
        listing
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to create manual listing."
      });
    }
  }
);

app.put(
  "/api/admin/account-logs/manual/:id",
  ...administrator,
  async (req, res) => {
    try {
      const id = cleanString(req.params.id, 150);
      const title = cleanString(req.body.title, 150);
      const description = cleanString(req.body.description, 1000);
      const price = Number(req.body.price);

      if (
        !id ||
        /[.#$\[\]/]/.test(id) ||
        !title ||
        !validMoney(price) ||
        price <= 0
      ) {
        return res.status(400).json({
          error: "Invalid listing details."
        });
      }

      const ref = database()
        .ref(`settings/accountLogs/manual/${id}`);

      const snapshot = await ref.once("value");

      if (!snapshot.exists()) {
        return res.status(404).json({
          error: "Listing not found."
        });
      }

      await ref.update({
        title,
        description,
        price,
        active: req.body.active !== false,
        updatedAt: Date.now()
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: "Unable to update listing."
      });
    }
  }
);

app.delete(
  "/api/admin/account-logs/manual/:id",
  ...administrator,
  async (req, res) => {
    try {
      const id = cleanString(req.params.id, 150);

      await database()
        .ref(`settings/accountLogs/manual/${id}`)
        .remove();

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: "Unable to delete listing."
      });
    }
  }
);

app.get(
  "/api/account-logs/manual",
  authenticated,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref("settings/accountLogs/manual")
        .once("value");

      const listings = snapshot.val() || {};

      res.json({
        listings: Object.entries(listings)
          .filter(([, item]) => item && item.active === true)
          .map(([id, item]) => ({
            id,
            title: item.title,
            description: item.description || "",
            price: Number(item.price),
            currency: "NGN"
          }))
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load manual Account Logs listings."
      });
    }
  }
);

// --------------------------------------------------
// MY SMM: ACCOUNT BOOSTING
// Provider rate is per 1,000.
// Formula:
// rate * quantity / 1000 * USD_TO_NGN_RATE
// * (1 + BOOST_MARKUP_PERCENT / 100)
// --------------------------------------------------

function mysmmUrl(params) {
  if (!process.env.MYSMM_API_KEY) {
    throw new Error("MYSMM_API_KEY is not configured.");
  }

  const url = new URL(MYSMM_URL);
  url.searchParams.set("key", process.env.MYSMM_API_KEY);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  return url;
}

async function mysmmRequest(params, method = "GET") {
  const url = mysmmUrl(params);

  return providerFetch(url.toString(), {
    method
  });
}

async function mysmmPost(params) {
  const url = mysmmUrl({});

  const body = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      body.set(key, String(value));
    }
  });

  return providerFetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
}

function calculateBoostPrice(rate, quantity) {
  const base = Number(rate) * Number(quantity) / 1000;

  return money(
    base *
    USD_TO_NGN_RATE *
    (1 + BOOST_MARKUP_PERCENT / 100)
  );
}

// Admin: check MySMM provider balance.
app.get(
  "/api/admin/mysmm/balance",
  ...administrator,
  async (req, res) => {
    try {
      const result = await mysmmRequest({
        action: "balance"
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to retrieve MySMM balance."
        );
      }

      res.json(result.data);
    } catch (error) {
      res.status(500).json({
        error: error.message || "MySMM connection failed."
      });
    }
  }
);

// Load boosting services and calculate customer prices.
app.get(
  "/api/boost/services",
  authenticated,
  async (req, res) => {
    try {
      const result = await mysmmRequest({
        action: "services"
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to load boosting services."
        );
      }

      const services = Array.isArray(result.data)
        ? result.data
        : result.data.services || result.data.data || [];

      if (!Array.isArray(services)) {
        return res.status(502).json({
          error: "MySMM returned an unexpected services response."
        });
      }

      const pricedServices = services.map(service => ({
        ...service,
        customerPricePer1000: calculateBoostPrice(
          Number(service.rate || 0),
          1000
        ),
        currency: "NGN"
      }));

      res.json({
        services: pricedServices,
        usdToNgnRate: USD_TO_NGN_RATE,
        markupPercent: BOOST_MARKUP_PERCENT
      });
    } catch (error) {
      console.error("MySMM services error:", error.message);

      res.status(500).json({
        error: error.message || "Unable to load boosting services."
      });
    }
  }
);

// Place a boosting order.
app.post(
  "/api/boost/orders",
  authenticated,
  async (req, res) => {
    const uid = req.user.uid;

    try {
      const requestKey = safeRequestKey(req.body.request_key);
      const service = cleanString(String(req.body.service || ""), 100);
      const link = cleanString(req.body.link, 1500);
      const quantity = Number(req.body.quantity);

      if (
        !service ||
        !link ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          error: "A service, valid link and positive whole-number quantity are required."
        });
      }

      // Fetch the provider's actual service rate.
      const servicesResult = await mysmmRequest({
        action: "services"
      });

      if (!servicesResult.ok) {
        return sendProviderError(
          res,
          servicesResult,
          "Unable to verify the boosting service."
        );
      }

      const services = Array.isArray(servicesResult.data)
        ? servicesResult.data
        : servicesResult.data.services || servicesResult.data.data || [];

      const selectedService = services.find(
        item => String(item.service) === service
      );

      if (!selectedService) {
        return res.status(400).json({
          error: "The selected boosting service is unavailable."
        });
      }

      const min = Number(selectedService.min || 1);
      const max = Number(selectedService.max || Number.MAX_SAFE_INTEGER);

      if (quantity < min || quantity > max) {
        return res.status(400).json({
          error: `Quantity must be between ${min} and ${max}.`
        });
      }

      const rate = Number(selectedService.rate);

      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(502).json({
          error: "The provider returned an invalid service rate."
        });
      }

      const price = calculateBoostPrice(rate, quantity);

      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
          error: "Unable to calculate the order price."
        });
      }

      const reservation = await reservePurchase(
        uid,
        requestKey,
        {
          provider: "mysmm",
          product: "boost",
          service,
          quantity,
          price,
          currency: "NGN"
        }
      );

      if (!reservation.created) {
        return res.status(409).json({
          error: "This order request has already been submitted. Do not submit it again with a new request key.",
          request: reservation.record
        });
      }

      const orderRef = database()
        .ref(`users/${uid}/boostOrders/${requestKey}`);

      await orderRef.set({
        provider: "mysmm",
        service,
        serviceName: selectedService.name || "",
        link,
        quantity,
        providerRate: rate,
        price,
        currency: "NGN",
        status: "reserved",
        createdAt: Date.now()
      });

      try {
        const debit = await debitWallet(
          uid,
          price,
          `mysmm_${requestKey}`,
          "Account boosting order"
        );

        await updatePurchase(uid, requestKey, {
          status: "payment_debited",
          balanceAfter: debit.balance
        });

        await orderRef.update({
          status: "submitting",
          balanceAfter: debit.balance
        });
      } catch (error) {
        await updatePurchase(uid, requestKey, {
          status: "payment_failed",
          error: error.message
        });

        await orderRef.update({
          status: "payment_failed"
        });

        return res.status(400).json({
          error: error.message
        });
      }

      let result;

      try {
        result = await mysmmPost({
          action: "add",
          service,
          link,
          quantity
        });
      } catch (error) {
        await updatePurchase(uid, requestKey, {
          status: "provider_status_unknown"
        });

        await orderRef.update({
          status: "provider_status_unknown"
        });

        return res.status(202).json({
          status: "provider_status_unknown",
          message: "Your boosting order is being checked. Do not submit it again."
        });
      }

      const providerOrderId = result.data &&
        (result.data.order || result.data.order_id);

      if (result.ok && providerOrderId) {
        await updatePurchase(uid, requestKey, {
          status: "submitted",
          providerOrderId: String(providerOrderId)
        });

        await orderRef.update({
          status: "submitted",
          providerOrderId: String(providerOrderId),
          providerResponse: result.data
        });

        return res.json({
          success: true,
          status: "submitted",
          order: String(providerOrderId),
          price,
          currency: "NGN"
        });
      }

      // Clear provider rejection: refund the wallet.
      if (result.status >= 400 && result.status < 500) {
        await refundWallet(
          uid,
          price,
          `mysmm_${requestKey}`,
          "MySMM order rejected"
        );

        await updatePurchase(uid, requestKey, {
          status: "provider_failed_refunded",
          providerResponse: result.data
        });

        await orderRef.update({
          status: "provider_failed_refunded",
          providerResponse: result.data
        });

        return res.status(502).json({
          error: providerErrorMessage(
            result.data,
            "The boosting provider rejected the order. Your wallet has been refunded."
          ),
          refunded: true
        });
      }

      await updatePurchase(uid, requestKey, {
        status: "provider_status_unknown",
        providerResponse: result.data
      });

      await orderRef.update({
        status: "provider_status_unknown",
        providerResponse: result.data
      });

      res.status(202).json({
        status: "provider_status_unknown",
        message: "The provider response is uncertain. Your order has been saved for checking."
      });
    } catch (error) {
      console.error("Boost order error:", error.message);

      res.status(400).json({
        error: error.message || "Unable to place boosting order."
      });
    }
  }
);

// User's boosting order history.
app.get(
  "/api/boost/orders",
  authenticated,
  async (req, res) => {
    try {
      const snapshot = await database()
        .ref(`users/${req.user.uid}/boostOrders`)
        .once("value");

      const orders = snapshot.val() || {};

      res.json({
        orders: Object.entries(orders).map(([requestKey, order]) => ({
          requestKey,
          ...order
        }))
      });
    } catch (error) {
      res.status(500).json({
        error: "Unable to load boosting orders."
      });
    }
  }
);

// Check MySMM order status.
app.get(
  "/api/boost/orders/:requestKey/status",
  authenticated,
  async (req, res) => {
    try {
      const requestKey = safeRequestKey(req.params.requestKey);

      const ref = database().ref(
        `users/${req.user.uid}/boostOrders/${requestKey}`
      );

      const snapshot = await ref.once("value");
      const order = snapshot.val();

      if (!order || !order.providerOrderId) {
        return res.status(404).json({
          error: "Provider order reference is not available for this order."
        });
      }

      const result = await mysmmRequest({
        action: "status",
        order: order.providerOrderId
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to check boosting order status."
        );
      }

      await ref.update({
        latestStatus: result.data,
        checkedAt: Date.now()
      });

      res.json({
        order,
        status: result.data
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to check order status."
      });
    }
  }
);

// Request cancellation from MySMM.
// The supplied API response does not establish a refund amount.
// Therefore this route does not automatically credit the wallet.
app.post(
  "/api/boost/orders/:requestKey/cancel",
  authenticated,
  async (req, res) => {
    try {
      const requestKey = safeRequestKey(req.params.requestKey);

      const ref = database().ref(
        `users/${req.user.uid}/boostOrders/${requestKey}`
      );

      const snapshot = await ref.once("value");
      const order = snapshot.val();

      if (!order || !order.providerOrderId) {
        return res.status(404).json({
          error: "Boosting order not found."
        });
      }

      const result = await mysmmPost({
        action: "cancel",
        orders: order.providerOrderId
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to request cancellation."
        );
      }

      await ref.update({
        cancellationResponse: result.data,
        cancellationRequestedAt: Date.now(),
        status: "cancellation_requested"
      });

      res.json({
        success: true,
        status: "cancellation_requested",
        message: "Cancellation was requested. Any refund must be confirmed separately."
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to cancel boosting order."
      });
    }
  }
);

// Request a MySMM refill.
app.post(
  "/api/boost/orders/:requestKey/refill",
  authenticated,
  async (req, res) => {
    try {
      const requestKey = safeRequestKey(req.params.requestKey);

      const ref = database().ref(
        `users/${req.user.uid}/boostOrders/${requestKey}`
      );

      const snapshot = await ref.once("value");
      const order = snapshot.val();

      if (!order || !order.providerOrderId) {
        return res.status(404).json({
          error: "Boosting order not found."
        });
      }

      const result = await mysmmPost({
        action: "refill",
        order: order.providerOrderId
      });

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to request refill."
        );
      }

      await ref.update({
        refillResponse: result.data,
        refillRequestedAt: Date.now()
      });

      res.json({
        success: true,
        result: result.data
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to request refill."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN: PROVIDER ORDER OVERVIEWS
// --------------------------------------------------

app.get(
  "/api/admin/wickspend/orders",
  ...administrator,
  async (req, res) => {
    try {
      const result = await wickspendGet("/numbers/orders");

      if (!result.ok) {
        return sendProviderError(
          res,
          result,
          "Unable to load WickSpend orders."
        );
      }

      res.json(result.data);
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to load WickSpend orders."
      });
    }
  }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`CPOVERIFY backend running on port ${PORT}`);
});
