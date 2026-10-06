const express = require('express');
const bcrypt = require('bcryptjs');

function userRoutes(pool, verifyToken, upload) {
  const router = express.Router();

  // 1. USER PROFILE & ACCOUNT SUMMARY
  router.get('/user/profile', verifyToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT user_id, phone, vip_level, avatar_url, balance, fund_password, referral_code FROM users WHERE user_id = ?', 
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
          hasFundPassword: user.fund_password ? true : false,
          referral_code: user.referral_code
        } 
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Server database error' });
    }
  });

  router.get('/user/account-summary', verifyToken, async (req, res) => {
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

  router.post('/user/update-avatar', verifyToken, async (req, res) => {
    const { avatar } = req.body;
    try {
      await pool.query('UPDATE users SET avatar_url = ? WHERE user_id = ?', [avatar, req.user.id]);
      res.json({ success: true, message: 'Avatar updated successfully' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to update avatar' });
    }
  });

  // 2. BANK CARD / WITHDRAWAL ACCOUNTS
  const getBankCardHandler = async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT channel, official_name, account_number FROM bank_cards WHERE user_id = ?', [req.user.id]);
      if (rows.length === 0) {
        return res.json({ success: true, card: null });
      }
      res.json({ success: true, card: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Error fetching bank card' });
    }
  };

  router.get('/bankcard', verifyToken, getBankCardHandler);
  router.get('/user/bank-card', verifyToken, getBankCardHandler);

  router.post('/bankcard', verifyToken, async (req, res) => {
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

  // 3. ACCOUNTING RECORDS
  router.get('/accounting', verifyToken, async (req, res) => {
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

  // 4. PASSWORD & FUND PASSWORD MANAGEMENT
  router.post('/auth/change-password', verifyToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    try {
      const [users] = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [req.user.id]);
      if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

      const isMatch = await bcrypt.compare(oldPassword, users[0].password_hash);
      if (!isMatch) return res.status(400).json({ success: false, message: 'Incorrect old password' });

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashedPassword, req.user.id]);
      res.json({ success: true, message: 'Password updated successfully!' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error updating password' });
    }
  });

  router.post('/auth/set-fund-password', verifyToken, async (req, res) => {
    const { accountPassword, fundPassword, confirmFundPassword } = req.body;

    if (!fundPassword || !/^\d{4,6}$/.test(fundPassword)) {
      return res.status(400).json({ success: false, message: 'Fund password must be 4 to 6 numeric digits.' });
    }
    if (fundPassword !== confirmFundPassword) {
      return res.status(400).json({ success: false, message: 'Fund passwords do not match.' });
    }

    try {
      const [users] = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [req.user.id]);
      if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

      const isMatch = await bcrypt.compare(accountPassword, users[0].password_hash);
      if (!isMatch) return res.status(400).json({ success: false, message: 'Incorrect account login password' });

      const salt = await bcrypt.genSalt(10);
      const hashedFundPassword = await bcrypt.hash(fundPassword, salt);

      await pool.query('UPDATE users SET fund_password = ? WHERE user_id = ?', [hashedFundPassword, req.user.id]);
      res.json({ success: true, message: 'Fund password updated successfully!' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server database error' });
    }
  });

  // 5. RECHARGE & PAYMENT GATEWAYS
  router.get('/recharge/config', verifyToken, async (req, res) => {
    try {
      res.json({
        success: true,
        exchangeRate: 12.5,
        usdtAddress: process.env.USDT_WALLET_ADDRESS || 'TByjYGQHM4H29bngfATXPyQSepdfSKEABn',
        kbNumber: process.env.KB_NUMBER || '0599432374',
        kbName: process.env.KB_NAME || 'MATHIAS KOFI LUMOR',
        solNumber: process.env.SOL_NUMBER || '0502835489',
        solName: process.env.SOL_NAME || 'GIDEON ODURO YEBOAH'
      });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to load recharge configuration' });
    }
  });

  router.post('/recharge/submit', verifyToken, async (req, res) => {
    const { amount, channel, transactionId, reference } = req.body;
    try {
      await pool.query(
        'INSERT INTO deposits (user_id, amount, channel, transaction_id, reference, status, created_at) VALUES (?, ?, ?, ?, ?, "pending", NOW())',
        [req.user.id, amount, channel, transactionId || '', reference || '']
      ).catch(() => {});

      res.json({ success: true, message: 'Recharge request submitted successfully. Awaiting approval.' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to process recharge submission' });
    }
  });

  router.post('/recharge/submit-with-proof', verifyToken, upload.single('proofImage'), async (req, res) => {
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
      res.status(500).json({ success: false, message: 'Failed to upload deposit proof' });
    }
  });

  // 6. WITHDRAWALS
  router.get('/withdraw/history', verifyToken, async (req, res) => {
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

        await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [totalDeduction, req.user.id]);
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
      res.status(500).json({ success: false, message: 'Server error processing withdrawal' });
    }
  };

  router.post('/withdraw/request', verifyToken, handleWithdrawalRequest);
  router.post('/withdraw/submit', verifyToken, handleWithdrawalRequest);
  router.post('/user/withdraw', verifyToken, handleWithdrawalRequest);
  router.post('/wallet/withdraw', verifyToken, handleWithdrawalRequest);

  return router;
}

module.exports = userRoutes;