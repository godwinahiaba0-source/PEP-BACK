require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Middleware
app.use(cors());
app.use(express.json());

// SQL Database Pool Connection
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Authentication Middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// ==========================================
// 1. USER PROFILE & ACCOUNT SUMMARY
// ==========================================
app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, phone, vip_level, avatar, balance FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server database error' });
  }
});

app.get('/api/user/account-summary', verifyToken, async (req, res) => {
  try {
    // Fetch live metrics or defaults for user dashboard
    const [rows] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    const balance = rows.length > 0 ? rows[0].balance : 0.00;

    res.json({
      success: true,
      data: {
        balance: balance,
        yesterdayEarnings: 0.00,
        investmentBenefits: 0.00,
        todayEarnings: 0.00,
        teamBenefits: 0.00,
        thisWeekEarnings: 0.00,
        referralRebate: 0.00,
        thisMonthEarnings: 0.00
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/user/update-avatar', verifyToken, async (req, res) => {
  const { avatar } = req.body;
  try {
    await pool.query('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);
    res.json({ success: true, message: 'Avatar updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update avatar' });
  }
});

// ==========================================
// 2. DEVICE MANAGEMENT (VIP Levels 1-12)
// ==========================================
app.get('/api/devices/list', verifyToken, async (req, res) => {
  const devices = [
    { id: 1, name: 'VIP1', price: 100, hourly_yield: 0.26 },
    { id: 2, name: 'VIP2', price: 200, hourly_yield: 0.46 },
    { id: 3, name: 'VIP3', price: 500, hourly_yield: 1.04 },
    { id: 4, name: 'VIP4', price: 1500, hourly_yield: 2.84 },
    { id: 5, name: 'VIP5', price: 3000, hourly_yield: 6.25 },
    { id: 6, name: 'VIP6', price: 10000, hourly_yield: 17.36 },
    { id: 7, name: 'VIP7', price: 20000, hourly_yield: 37.87 },
    { id: 8, name: 'VIP8', price: 60000, hourly_yield: 125.00 },
    { id: 9, name: 'VIP9', price: 150000, hourly_yield: 347.22 },
    { id: 10, name: 'VIP10', price: 300000, hourly_yield: 781.25 },
    { id: 11, name: 'VIP11', price: 450000, hourly_yield: 1171.88 },
    { id: 12, name: 'VIP12', price: 500000, hourly_yield: 1302.08 }
  ];
  res.json({ success: true, data: devices });
});

app.get('/api/devices/my-devices', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT device_id FROM user_devices WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading user devices' });
  }
});

app.post('/api/devices/buy', verifyToken, async (req, res) => {
  const { device_id } = req.body;
  // Handle device purchase logic, balance check, and insertion into user_devices
  res.json({ success: true, message: 'Device purchased successfully!' });
});

// ==========================================
// 3. BANK CARD / WITHDRAWAL ACCOUNTS
// ==========================================
app.get('/api/bankcard', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT channel, official_name, account_number FROM bank_cards WHERE user_id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.json({ success: true, card: null });
    }
    res.json({ success: true, card: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching bank card' });
  }
});

app.post('/api/bankcard', verifyToken, async (req, res) => {
  const { channel, official_name, account_number } = req.body;
  try {
    await pool.query(
      'REPLACE INTO bank_cards (user_id, channel, official_name, account_number) VALUES (?, ?, ?, ?)',
      [req.user.id, channel, official_name, account_number]
    );
    res.json({ success: true, message: 'Withdrawal account bound successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to bind account' });
  }
});

// ==========================================
// 4. WEALTH MANAGEMENT / YF LIFE FUND
// ==========================================
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  res.json({
    success: true,
    summary: { activeInvested: 0.00, todaysEarnings: 0.00 }
  });
});

app.get('/api/fund/records', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM fund_investments WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, records: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading fund records' });
  }
});

app.post('/api/fund/invest', verifyToken, async (req, res) => {
  const { depositAmount, days, profitPercent, expectedProfit } = req.body;
  try {
    await pool.query(
      'INSERT INTO fund_investments (user_id, deposit_amount, days, profit_percent, expected_profit, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, depositAmount, days, profitPercent, expectedProfit, 'Active']
    );
    res.json({ success: true, message: 'Investment submitted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to process investment' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 New backend running locally on port ${PORT}`);
});