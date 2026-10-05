require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer'); // <--- Required for parsing screenshot uploads
const path = require('path');

const { initDeviceWorker, buyDevice } = require('./deviceController');
const { getTeamReport } = require('./teamController');
const { register, login } = require('./authController'); 

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Configure Multer storage for receipt / proof uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Ensure this folder exists or change destination as needed
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads')); // Serve uploaded files statically if needed

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

// Initialize the 24/7 hourly background payout worker
initDeviceWorker(pool);

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
// 0. AUTHENTICATION (Mounted from Controller)
// ==========================================
app.post('/api/auth/register', (req, res) => {
  register(req, res, pool);
});

app.post('/api/auth/login', (req, res) => {
  login(req, res, pool, JWT_SECRET);
});

// ==========================================
// 1. USER PROFILE & ACCOUNT SUMMARY
// ==========================================
app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT user_id, phone, vip_level, avatar_url, balance, fund_password FROM users WHERE user_id = ?', 
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    
    const user = rows[0];
    res.json({ 
      success: true, 
      user: {
        id: user.user_id,
        phone: user.phone,
        vip_level: user.vip_level,
        avatar_url: user.avatar_url,
        balance: user.balance,
        hasFundPassword: user.fund_password ? true : false // <--- Feeds the frontend badge status in fund passwd.html
      } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server database error' });
  }
});

app.get('/api/user/account-summary', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT balance, referral_rebate, vip_level FROM users WHERE user_id = ?', [req.user.id]);
    const user = rows.length > 0 ? rows[0] : { balance: 0.00, referral_rebate: 0.00, vip_level: 0 };

    res.json({
      success: true,
      data: {
        balance: user.balance,
        vipLevel: user.vip_level,
        yesterdayEarnings: 0.00,
        investmentBenefits: 0.00,
        todayEarnings: 0.00,
        teamBenefits: 0.00,
        thisWeekEarnings: 0.00,
        referralRebate: user.referral_rebate,
        thisMonthEarnings: 0.00
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/user/update-avatar', verifyToken, async (req, res) => {
  const { avatar } = req.body;
  try {
    await pool.query('UPDATE users SET avatar_url = ? WHERE user_id = ?', [avatar, req.user.id]);
    res.json({ success: true, message: 'Avatar updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update avatar' });
  }
});

// ==========================================
// 2. DEVICE MANAGEMENT (Mounted from Controller)
// ==========================================
app.get('/api/devices/list', verifyToken, async (req, res) => {
  try {
    const [devices] = await pool.query('SELECT id, name, price, hourly_yield FROM vip_devices');
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading devices' });
  }
});

app.get('/api/devices/my-devices', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT user_device_id, device_id, hourly_yield, status FROM user_devices WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading user devices' });
  }
});

app.post('/api/devices/buy', verifyToken, (req, res) => {
  req.body.userId = req.user.id;
  buyDevice(req, res, pool);
});

// ==========================================
// 3. TEAM REPORT & METRICS (Mounted from Controller)
// ==========================================
app.get('/api/team/report', verifyToken, (req, res) => {
  getTeamReport(req, res, pool);
});

// ==========================================
// 4. BANK CARD / WITHDRAWAL ACCOUNTS
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

app.get('/api/user/bank-card', verifyToken, async (req, res) => {
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
// 5. ACCOUNTING RECORDS (accounting.html)
// ==========================================
app.get('/api/accounting', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, type, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC', 
      [req.user.id]
    ).catch(() => [[]]); 

    res.json({ success: true, records: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to load accounting records' });
  }
});

// ==========================================
// 6. PASSWORD & FUND PASSWORD MANAGEMENT
// ==========================================
app.post('/api/auth/change-password', verifyToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const [users] = await pool.query('SELECT password FROM users WHERE user_id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const user = users[0];
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect old password' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await pool.query('UPDATE users SET password = ? WHERE user_id = ?', [hashedPassword, req.user.id]);
    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error updating password' });
  }
});

app.post('/api/auth/set-fund-password', verifyToken, async (req, res) => {
  const { accountPassword, fundPassword, confirmFundPassword } = req.body;

  if (!fundPassword || !/^\d{4,6}$/.test(fundPassword)) {
    return res.status(400).json({ success: false, message: 'Fund password must be 4 to 6 numeric digits.' });
  }

  if (fundPassword !== confirmFundPassword) {
    return res.status(400).json({ success: false, message: 'Fund passwords do not match.' });
  }

  try {
    const [users] = await pool.query('SELECT password FROM users WHERE user_id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const isMatch = await bcrypt.compare(accountPassword, users[0].password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect account login password' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedFundPassword = await bcrypt.hash(fundPassword, salt);

    await pool.query('UPDATE users SET fund_password = ? WHERE user_id = ?', [hashedFundPassword, req.user.id]);

    res.json({ success: true, message: 'Fund password updated successfully!' });
  } catch (err) {
    console.error('Error setting fund password:', err);
    res.status(500).json({ success: false, message: 'Server database error' });
  }
});

// ==========================================
// 7. RECHARGE & PAYMENT GATEWAYS (recharge.html)
// ==========================================
app.get('/api/recharge/config', verifyToken, async (req, res) => {
  try {
    res.json({
      success: true,
      exchangeRate: 12.5,
      usdtAddress: process.env.USDT_WALLET_ADDRESS || 'TYourUSDTWalletAddressHere...',
      kbNumber: process.env.KB_NUMBER || '0590000000',
      kbName: process.env.KB_NAME || 'Platform Merchant',
      solNumber: process.env.SOL_NUMBER || '0540000000',
      solName: process.env.SOL_NAME || 'Platform Merchant'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load recharge configuration' });
  }
});

app.post('/api/recharge/submit', verifyToken, async (req, res) => {
  const { amount, channel, transactionId, reference } = req.body;
  try {
    await pool.query(
      'INSERT INTO deposits (user_id, amount, channel, transaction_id, reference, status, created_at) VALUES (?, ?, ?, ?, ?, "pending", NOW())',
      [req.user.id, amount, channel, transactionId || '', reference || '']
    ).catch(() => {});

    res.json({ success: true, message: 'Recharge request submitted successfully. Awaiting approval.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to process recharge submission' });
  }
});

app.post('/api/recharge/submit-with-proof', verifyToken, upload.single('proofImage'), async (req, res) => {
  const { amount, channel, transactionId } = req.body;
  const proofPath = req.file ? `/uploads/${req.file.filename}` : '';

  try {
    await pool.query(
      'INSERT INTO deposits (user_id, amount, channel, transaction_id, proof_image, status, created_at) VALUES (?, ?, ?, ?, ?, "pending", NOW())',
      [req.user.id, amount, channel, transactionId || '', proofPath]
    ).catch(() => {});

    const [userRows] = await pool.query('SELECT balance FROM users WHERE user_id = ?', [req.user.id]);
    const newBalance = userRows.length > 0 ? userRows[0].balance : 0;

    res.json({ success: true, message: 'Deposit proof uploaded successfully!', newBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to upload deposit proof' });
  }
});

// ==========================================
// 8. WITHDRAWALS (withdraw.html & wrec.html)
// ==========================================
app.get('/api/withdraw/history', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, amount, net_amount, method, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    ).catch(() => [[]]);

    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawal history' });
  }
});

const handleWithdrawalRequest = async (req, res) => {
  const { amount, handlingFee, netAmountToReceive, method, accountDetails, accountNumber } = req.body;
  
  try {
    const [userRows] = await pool.query('SELECT balance FROM users WHERE user_id = ?', [req.user.id]);
    if (userRows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    
    const currentBalance = userRows[0].balance;
    const totalDeduction = parseFloat(amount);

    if (currentBalance < totalDeduction) {
      return res.status(400).json({ success: false, message: 'Insufficient balance for withdrawal' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [totalDeduction || totalDeduction, req.user.id]);
      await connection.query(
        'INSERT INTO withdrawals (user_id, amount, fee, net_amount, method, account_info, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", NOW())',
        [req.user.id, amount, handlingFee || 0, netAmountToReceive || amount, method || 'Bank', accountNumber || accountDetails || '']
      );

      await connection.commit();
      connection.release();

      res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
    } catch (txErr) {
      await connection.rollback();
      connection.release();
      throw txErr;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error processing withdrawal' });
  }
};

app.post('/api/withdraw/request', verifyToken, handleWithdrawalRequest);
app.post('/api/withdraw/submit', verifyToken, handleWithdrawalRequest);
app.post('/api/user/withdraw', verifyToken, handleWithdrawalRequest);
app.post('/api/wallet/withdraw', verifyToken, handleWithdrawalRequest);

// ==========================================
// 9. ADMIN PANEL API ENDPOINTS
// ==========================================
async function verifyAdmin(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT is_admin FROM users WHERE user_id = ?', [req.user.id]);
    if (rows.length === 0 || rows[0].is_admin !== 1) {
      return res.status(403).json({ success: false, message: 'Access denied. Admin privileges required.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Authorization error' });
  }
}

// Get overall platform statistics
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [[{ totalUsers }]] = await pool.query('SELECT COUNT(*) as totalUsers FROM users');
    const [[{ totalBalance }]] = await pool.query('SELECT SUM(balance) as totalBalance FROM users');
    const [[{ pendingDeposits }]] = await pool.query('SELECT COUNT(*) as pendingDeposits FROM deposits WHERE status = "pending"');
    const [[{ pendingWithdrawals }]] = await pool.query('SELECT COUNT(*) as pendingWithdrawals FROM withdrawals WHERE status = "pending"');

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalBalance: totalBalance || 0.00,
        pendingDeposits: pendingDeposits || 0,
        pendingWithdrawals: pendingWithdrawals || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load stats' });
  }
});

// Get all users list
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT user_id, phone, vip_level, balance, referral_rebate, created_at FROM users ORDER BY created_at DESC');
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

// Get all deposits (Recharges)
app.get('/api/admin/deposits', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [deposits] = await pool.query(`
      SELECT d.*, u.phone 
      FROM deposits d 
      JOIN users u ON d.user_id = u.user_id 
      ORDER BY d.created_at DESC
    `);
    res.json({ success: true, deposits });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch deposits' });
  }
});

// Approve or Reject Deposit
app.post('/api/admin/deposits/action', verifyToken, verifyAdmin, async (req, res) => {
  const { depositId, action } = req.body; // action: 'approve' or 'reject'
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [depRows] = await connection.query('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (depRows.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Deposit record not found' });
    }

    const deposit = depRows[0];
    if (deposit.status !== 'pending') {
      connection.release();
      return res.status(400).json({ success: false, message: 'Deposit is already processed' });
    }

    if (action === 'approve') {
      // Update deposit status
      await connection.query('UPDATE deposits SET status = "approved" WHERE id = ?', [depositId]);
      // Add balance to user
      await connection.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [deposit.amount, deposit.user_id]);
      // Record transaction ledger
      await connection.query(
        'INSERT INTO transactions (user_id, title, description, type, amount, status) VALUES (?, "Recharge Approved", ?, "credit", ?, "completed")',
        [deposit.user_id, `Deposit via ${deposit.channel} approved`, deposit.amount]
      );
    } else {
      await connection.query('UPDATE deposits SET status = "rejected" WHERE id = ?', [depositId]);
    }

    await connection.commit();
    connection.release();
    res.json({ success: true, message: `Deposit successfully ${action}d` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ success: false, message: 'Server error processing action' });
  }
});

// Get all withdrawals
app.get('/api/admin/withdrawals', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [withdrawals] = await pool.query(`
      SELECT w.*, u.phone 
      FROM withdrawals w 
      JOIN users u ON w.user_id = u.user_id 
      ORDER BY w.created_at DESC
    `);
    res.json({ success: true, withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawals' });
  }
});

// Approve or Reject Withdrawal
app.post('/api/admin/withdrawals/action', verifyToken, verifyAdmin, async (req, res) => {
  const { withdrawalId, action } = req.body; // action: 'approve' or 'reject'
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [wRows] = await connection.query('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    if (wRows.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Withdrawal record not found' });
    }

    const withdrawal = wRows[0];
    if (withdrawal.status !== 'pending') {
      connection.release();
      return res.status(400).json({ success: false, message: 'Withdrawal is already processed' });
    }

    if (action === 'approve') {
      await connection.query('UPDATE withdrawals SET status = "approved" WHERE id = ?', [withdrawalId]);
      await connection.query(
        'INSERT INTO transactions (user_id, title, description, type, amount, status) VALUES (?, "Withdrawal Paid", ?, "debit", ?, "completed")',
        [withdrawal.user_id, `Withdrawal via ${withdrawal.method} processed`, withdrawal.amount]
      );
    } else {
      // If rejected, refund the balance back to the user
      await connection.query('UPDATE withdrawals SET status = "rejected" WHERE id = ?', [withdrawalId]);
      await connection.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [withdrawal.amount, withdrawal.user_id]);
    }

    await connection.commit();
    connection.release();
    res.json({ success: true, message: `Withdrawal successfully ${action}d` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ success: false, message: 'Server error processing action' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running locally on port ${PORT}`);
});