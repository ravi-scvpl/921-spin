const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_SALT = process.env.SECRET_SALT || "921_BASMATI_RICE_SECRET_SALT_2026";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const FIREBASE_DB_URL = firebaseConfig.databaseURL;

const FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET;
const serviceAccountPath = path.join(__dirname, 'serviceAccount.json');
const hasServiceAccount = fs.existsSync(serviceAccountPath);
const localServiceAccount = hasServiceAccount ? require(serviceAccountPath) : {};

const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID || localServiceAccount.project_id,
  private_key: process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
    : localServiceAccount.private_key,
  client_email: process.env.FIREBASE_CLIENT_EMAIL || localServiceAccount.client_email
};

const hasCredentials = !!(serviceAccount.project_id && serviceAccount.private_key && serviceAccount.client_email);

// Helper to get Google OAuth2 Access Token using the service account JWT (no dependencies)
async function getAccessToken() {
  if (!hasCredentials) return null;
  
  const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  
  const now = Math.floor(Date.now() / 1000);
  const jwtClaimSet = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  
  const signatureInput = `${jwtHeader}.${jwtClaimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  
  const jwt = `${signatureInput}.${signature}`;
  
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to generate Google Access Token: ${res.status} - ${text}`);
  }
  
  const data = await res.json();
  return data.access_token;
}

// Helper to read data from Firebase Realtime Database
async function readFirebase(node) {
  try {
    const headers = {};
    let url = `${FIREBASE_DB_URL}/${node}.json`;
    
    if (hasCredentials) {
      const token = await getAccessToken();
      headers['Authorization'] = `Bearer ${token}`;
    } else if (FIREBASE_DB_SECRET) {
      url += `?auth=${FIREBASE_DB_SECRET}`;
    }
    
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Firebase read error: ${res.status} - ${errText}`);
    }
    const data = await res.json();
    if (!data) return [];
    // Convert Firebase object map to array
    return Object.keys(data).map(key => ({ id: key, ...data[key] }));
  } catch (e) {
    console.error("Error reading from Firebase:", node, e);
    throw e;
  }
}

// Helper to push/append data to Firebase Realtime Database
async function pushFirebase(node, item) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    let url = `${FIREBASE_DB_URL}/${node}.json`;
    
    if (hasCredentials) {
      const token = await getAccessToken();
      headers['Authorization'] = `Bearer ${token}`;
    } else if (FIREBASE_DB_SECRET) {
      url += `?auth=${FIREBASE_DB_SECRET}`;
    }
    
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(item)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Firebase write error: ${res.status} - ${errText}`);
    }
  } catch (e) {
    console.error("Error writing to Firebase:", node, e);
    throw e;
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
