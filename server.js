const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();
const mongoose = require('mongoose');

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/921spin';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB database successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Schemas & Models
const spinSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  playId: { type: String, required: true },
  deviceId: { type: String, required: true, index: true },
  type: { type: String, required: true }
});

const claimSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  playId: { type: String, default: "" },
  claimRef: { type: String, default: "" },
  name: { type: String, default: "" },
  phone: { type: String, required: true, index: true },
  city: { type: String, default: "" },
  rewardType: { type: String, default: "" },
  rewardTitle: { type: String, default: "" },
  couponCode: { type: String, default: "" },
  address: { type: String, default: "" },
  stateName: { type: String, default: "" },
  pincode: { type: String, default: "" },
  deviceId: { type: String, default: "" },
  status: { type: String, default: "VALID" }
});

const Spin = mongoose.model('Spin', spinSchema);
const Claim = mongoose.model('Claim', claimSchema);

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

// Check if device has already spun in MongoDB
async function isDeviceSpun(deviceId) {
  const count = await Spin.countDocuments({ deviceId });
  return count > 0;
}

// Check if we already have a grand winner this week in MongoDB
async function hasGrandWinnerThisWeek() {
  const startOfWeek = getStartOfWeek();
  const count = await Claim.countDocuments({
    rewardType: 'grand',
    timestamp: { $gte: startOfWeek }
  });
  return count > 0;
}

// Get total spin count for the current calendar week
async function getWeeklySpinsCount() {
  const startOfWeek = getStartOfWeek();
  return await Spin.countDocuments({
    timestamp: { $gte: startOfWeek }
  });
}

// Check if phone is registered in MongoDB
async function isPhoneRegistered(phone) {
  const cleanPhone = String(phone).replace(/\D/g, "");
  const target = cleanPhone.length > 10 ? cleanPhone.slice(-10) : cleanPhone;
  
  // Search phone matching ending target digits
  const claims = await Claim.find({}, { phone: 1 }).lean();
  return claims.some(c => {
    const val = String(c.phone).replace(/\D/g, "");
    const cleanVal = val.length > 10 ? val.slice(-10) : val;
    return cleanVal === target;
  });
}

// Compatibility helper for writing data to MongoDB
async function pushFirebase(node, item) {
  try {
    if (node === 'spins') {
      await Spin.create(item);
    } else if (node === 'claims') {
      await Claim.create(item);
    }
  } catch (e) {
    console.error("Error writing to MongoDB:", node, e);
    throw e;
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_SALT = process.env.SECRET_SALT || "921_BASMATI_RICE_SECRET_SALT_2026";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

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
      const weeklySpins = await getWeeklySpinsCount();
      const winRate = parseFloat(process.env.WIN_RATE || "0.005"); // Default 0.5% (1 in 200)
      const targetSpins = parseInt(process.env.TARGET_SPINS_PER_WEEK || "200", 10); // Target spins threshold

      if (weeklySpins >= targetSpins - 1) {
        // Guaranteed winner if target spins per week reached without a winner yet
        isGrand = true;
      } else {
        isGrand = Math.random() < winRate;
      }
    }

    let outcome;
    if (isGrand) {
      outcome = {
        type: "grand",
        digits: [9, 2, 1],
        title: "Congratulations, You’re a Winner! 🎉",
        description: "Enjoy 3 kg of premium, long-grain 921 Basmati Rice every month for a year!<br><br>Our team will contact you shortly."
      };
    } else {
      const target = [9, 2, 1];
      const digits = [0, 0, 0];
      const matchIndex = Math.floor(Math.random() * 3);
      for (let i = 0; i < 3; i++) {
        if (i === matchIndex) {
          digits[i] = target[i];
        } else {
          let randDigit;
          do {
            randDigit = Math.floor(Math.random() * 10);
          } while (randDigit === target[i]);
          digits[i] = randDigit;
        }
      }
      outcome = {
        type: "lose",
        digits: digits,
        title: "Better luck in our next contest!",
        description: "We appreciate your participation. <br>  Follow 921 Basmati Rice for exciting contests and more opportunities to win big!"
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

// Action 2A: SEND OTP (2Factor.in SMS Gateway)
app.post('/api/send_otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ status: "error", message: "Missing phone number" });
    }
    const cleanPhone = String(phone).replace(/\D/g, "");
    const targetPhone = cleanPhone.length > 10 ? cleanPhone.slice(-10) : cleanPhone;
    const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;
    const TWOFACTOR_TEMPLATE_NAME = process.env.TWOFACTOR_TEMPLATE_NAME || 'OTP1';

    if (!TWOFACTOR_API_KEY || TWOFACTOR_API_KEY === 'your_2factor_api_key_here') {
      console.warn("2Factor API Key not configured. Running in Mock Mode for phone:", targetPhone);
      const mockSessionId = 'MOCK_SESS_' + Date.now();
      return res.json({ status: "success", sessionId: mockSessionId, mock: true });
    }

    const twoFactorUrl = TWOFACTOR_TEMPLATE_NAME
      ? `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/${targetPhone}/AUTOGEN/${TWOFACTOR_TEMPLATE_NAME}`
      : `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/${targetPhone}/AUTOGEN`;
    const response = await fetch(twoFactorUrl);

    const data = await response.json();

    if (data && data.Status === "Success") {
      return res.json({ status: "success", sessionId: data.Details });
    } else {
      return res.status(400).json({ status: "error", message: data.Details || "Failed to send OTP via 2Factor." });
    }
  } catch (e) {
    console.error("Error sending OTP via 2Factor:", e);
    res.status(500).json({ status: "error", message: e.toString() });
  }
});

// Action 2B: VERIFY OTP (2Factor.in SMS Gateway)
app.post('/api/verify_otp', async (req, res) => {
  try {
    const { sessionId, otp } = req.body;
    if (!sessionId || !otp) {
      return res.status(400).json({ status: "error", message: "Missing session ID or OTP" });
    }
    const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;

    if (String(sessionId).startsWith('MOCK_SESS_') || !TWOFACTOR_API_KEY || TWOFACTOR_API_KEY === 'your_2factor_api_key_here') {
      console.warn("2Factor Mock Mode Verification for OTP:", otp);
      if (otp.length === 6) {
        return res.json({ status: "success", message: "OTP Verified (Mock Mode)" });
      } else {
        return res.status(400).json({ status: "error", message: "Invalid 6-digit OTP" });
      }
    }

    const verifyUrl = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${otp}`;
    const response = await fetch(verifyUrl);
    const data = await response.json();

    if (data && (data.Status === "Success" || data.Details === "OTP Matched")) {
      return res.json({ status: "success", message: "OTP Verified" });
    } else {
      return res.status(400).json({ status: "error", message: data.Details || "Invalid OTP. Please try again." });
    }
  } catch (e) {
    console.error("Error verifying OTP via 2Factor:", e);
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
  try {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }
    const claims = await Claim.find().sort({ timestamp: -1 }).lean();
    res.json({ status: "success", claims });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.toString() });
  }
});


// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
