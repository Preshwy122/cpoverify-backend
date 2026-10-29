const express = require("express");
const admin = require("firebase-admin");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
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

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "CPO-VERIFY Backend",
    status: "running"
  });
});

// Verify Firebase user
async function verifyFirebaseUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    if (!admin.apps.length) {
      return res.status(503).json({
        error: "Firebase backend is not configured"
      });
    }

    const token = authHeader.slice(7);
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired authentication token"
    });
  }
}

// Verify admin user
function verifyAdmin(req, res, next) {
  const adminUID = process.env.ADMIN_UID;

  if (!adminUID) {
    return res.status(503).json({
      error: "Admin is not configured"
    });
  }

  if (req.user.uid !== adminUID) {
    return res.status(403).json({
      error: "Admin access required"
    });
  }

  next();
}

// Get authenticated user
app.get("/api/me", verifyFirebaseUser, (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email || null
  });
});

// Check admin access
app.get(
  "/api/admin/check",
  verifyFirebaseUser,
  verifyAdmin,
  (req, res) => {
    res.json({
      admin: true,
      message: "Admin access verified"
    });
  }
);

// Get authenticated user's wallet balance
app.get("/api/wallet", verifyFirebaseUser, async (req, res) => {
  try {
    const uid = req.user.uid;

    const snapshot = await admin
      .database()
      .ref(`users/${uid}/wallet/balance`)
      .get();

    const balance = snapshot.exists()
      ? Number(snapshot.val())
      : 0;

    if (!Number.isFinite(balance) || balance < 0) {
      return res.status(500).json({
        error: "Wallet balance data is invalid"
      });
    }

    res.json({
      balance
    });
  } catch (error) {
    console.error("Wallet read error:", error.message);

    res.status(500).json({
      error: "Unable to retrieve wallet balance"
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`CPO-VERIFY backend running on port ${PORT}`);
});
