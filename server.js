const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const firebaseConfig = {
  apiKey: "AIzaSyD0mvXTWDmDV_PkgGAEMJn0zl0HxxhzDWo",
  authDomain: "socialrecharge.firebaseapp.com",
  databaseURL: "https://socialrecharge.firebaseio.com",
  projectId: "project-1956585320571671692",
  storageBucket: "project-1956585320571671692.appspot.com",
  messagingSenderId: "194244686544",
  appId: "1:194244686544:web:8f351790aa7a5bcc71e4d5",
  measurementId: "G-J4DY04HZXP"
};

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_SALT = process.env.SECRET_SALT || "921_BASMATI_RICE_SECRET_SALT_2026";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const FIREBASE_DB_URL = firebaseConfig.databaseURL;

// Helper to read data from Firebase Realtime Database
async function readFirebase(node) {
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/${node}.json`);
    const data = await res.json();
    if (!data) return [];
    // Convert Firebase object map to array
    return Object.keys(data).map(key => ({ id: key, ...data[key] }));
  } catch (e) {
    console.error("Error reading from Firebase:", node, e);
    return [];
  }
}

// Helper to push/append data to Firebase Realtime Database
async function pushFirebase(node, item) {
  try {
    await fetch(`${FIREBASE_DB_URL}/${node}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
  } catch (e) {
    console.error("Error writing to Firebase:", node, e);
  }
}

// Generate HMAC-SHA256 hex signature
function generateSignature(playId, outcomeType, secret) {
  return crypto.createHmac('sha256', secret)
               .update(`${playId}:${outcomeType}`)
               .digest('hex');
}

// Helper: Get start of current calendar week (Monday)
function getStartOfWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(d.setDate(diff));
  startOfWeek.setHours(0, 0, 0, 0);
  return startOfWeek;
}

// Check if device has already spun in Firebase
async function isDeviceSpun(deviceId) {
  const spins = await readFirebase('spins');
  return spins.some(s => s.deviceId === deviceId);
}

// Check if we already have a grand winner this week in Firebase
async function hasGrandWinnerThisWeek() {
  const claims = await readFirebase('claims');
  const startOfWeek = getStartOfWeek();
  return claims.some(c => c.rewardType === 'grand' && new Date(c.timestamp) >= startOfWeek);
}

// Check if phone is registered in Firebase
async function isPhoneRegistered(phone) {
  const claims = await readFirebase('claims');
  const cleanPhone = String(phone).replace(/\D/g, "");
  const target = cleanPhone.length > 10 ? cleanPhone.slice(-10) : cleanPhone;
  
  return claims.some(c => {
    const val = String(c.phone).replace(/\D/g, "");
    const cleanVal = val.length > 10 ? val.slice(-10) : val;
    return cleanVal === target;
  });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static Dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// Action 1: SPIN (Decide outcome securely and return signed token)
app.post('/api/spin', async (req, res) => {
  try {
    const { playId, deviceId } = req.body;
    if (!playId || !deviceId) {
      return res.status(400).json({ status: "error", message: "Missing parameters" });
    }

    if (await isDeviceSpun(deviceId)) {
      return res.json({ status: "already_spun", message: "You have already spun on this device." });
    }

    const alreadyHasGrand = await hasGrandWinnerThisWeek();
    let isGrand = false;
    if (!alreadyHasGrand) {
      isGrand = Math.random() < 0.0005; // 0.05% win rate
    }

    let outcome;
    if (isGrand) {
      outcome = {
        type: "grand",
        digits: [9, 2, 1],
        title: "Congratulations! You’ve won a year’s supply of 921 Basmati Rice",
        description: "Our team will touch with you very shortly."
      };
    } else {
      outcome = {
        type: "lose",
        digits: [9, 2, Math.floor(Math.random() * 8) + 2],
        title: "OOPs, Not this time!",
        description: "Thank you for participating. Better luck on your next spin!"
      };
    }

    // Sign outcome using HMAC-SHA256
    outcome.signature = generateSignature(playId, outcome.type, SECRET_SALT);

    // Log spin to Firebase
    await pushFirebase('spins', { timestamp: new Date().toISOString(), playId, deviceId, type: outcome.type });

    res.json({ status: "success", outcome });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.toString() });
  }
});

// Action 2: CHECK PHONE (Check if phone already played)
app.post('/api/check_phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ status: "error", message: "Missing phone number" });
    }
    const played = await isPhoneRegistered(phone);
    res.json({ status: "success", played });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.toString() });
  }
});

// Action 3: CLAIM (Validate details, verify signature, record claim)
app.post('/api/claim', async (req, res) => {
  try {
    const {
      playId,
      rewardType,
      signature: clientSignature,
      claimRef,
      name,
      phone,
      city,
      rewardTitle,
      couponCode,
      address,
      stateName,
      pincode,
      deviceId
    } = req.body;

    const expectedSignature = generateSignature(playId, rewardType, SECRET_SALT);
    const isTampered = (clientSignature !== expectedSignature);

    if (isTampered) {
      console.warn("ALERT: TAMPER_DETECTED for playId:", playId);
    }

    // Prevent duplicate phone number registration
    if (!isTampered && await isPhoneRegistered(phone)) {
      return res.json({ status: "error", message: "You have already played with this mobile number." });
    }

    const newClaim = {
      timestamp: new Date().toISOString(),
      playId: playId || "",
      claimRef: claimRef || "",
      name: name || "",
      phone: phone || "",
      city: city || "",
      rewardType: rewardType || "",
      rewardTitle: rewardTitle || "",
      couponCode: couponCode || "",
      address: address || "",
      stateName: stateName || "",
      pincode: pincode || "",
      deviceId: deviceId || "",
      status: isTampered ? "TAMPER_DETECTED" : "VALID"
    };

    // Save claim to Firebase
    await pushFirebase('claims', newClaim);

    if (isTampered) {
      return res.json({ status: "fraud_detected", message: "Verification failed. Incident logged." });
    }

    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.toString() });
  }
});

// Admin Authentication Route
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(16).toString('hex');
    res.json({ status: "success", token });
  } else {
    res.status(401).json({ status: "error", message: "Invalid username or password" });
  }
});

// Admin Get Claims Route
app.get('/api/admin/claims', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  const claims = await readFirebase('claims');
  res.json({ status: "success", claims });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
