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
      const userId = req.user.id;

      const [rows] = await pool.query(
        'SELECT balance, referral_rebate, total_team_benefits, vip_level FROM users WHERE user_id = ?', 
        [userId]
      );
      const user = rows.length > 0 ? rows[0] : { balance: 0.00, referral_rebate: 0.00, total_team_benefits: 0.00, vip_level: 0 };

      const earningTypes = ['yield', 'device_payout', 'payout', 'commission', 'REFERRAL_REBATE'];
      const placeholders = earningTypes.map(() => '?').join(',');

      const getSum = async (dateCondition, extraParams = []) => {
        const [resRows] = await pool.query(
          `SELECT SUM(amount) AS total FROM transactions 
           WHERE user_id = ? AND type IN (${placeholders}) 
           AND amount > 0 ${dateCondition}`,
          [userId, ...earningTypes, ...extraParams]
        ).catch(() => [{ total: 0 }]);
        return resRows[0]?.total || 0.00;
      };

      const todayEarnings = await getSum(`AND DATE(created_at) = CURDATE()`);
      const yesterdayEarnings = await getSum(`AND DATE(created_at) = CURDATE() - INTERVAL 1 DAY`);
      const thisWeekEarnings = await getSum(`AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)`);
      const thisMonthEarnings = await getSum(`AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())`);
      const investmentBenefits = await getSum(`AND (LOWER(title) LIKE '%yield%' OR LOWER(title) LIKE '%earning%' OR type = 'yield')`);
      const teamBenefits = await getSum(`AND (LOWER(title) LIKE '%commission%' OR LOWER(title) LIKE '%team%' OR type = 'commission')`);
      const referralRebate = await getSum(`AND (LOWER(title) LIKE '%rebate%' OR type = 'REFERRAL_REBATE')`);

      res.json({
        success: true,
        data: {
          balance: user.balance,
          vipLevel: user.vip_level,
          yesterdayEarnings: parseFloat(yesterdayEarnings).toFixed(2),
          investmentBenefits: parseFloat(investmentBenefits).toFixed(2),
          todayEarnings: parseFloat(todayEarnings).toFixed(2),
          teamBenefits: parseFloat(teamBenefits || user.total_team_benefits || 0).toFixed(2),
          thisWeekEarnings: parseFloat(thisWeekEarnings).toFixed(2),
          referralRebate: parseFloat(referralRebate || user.referral_rebate || 0).toFixed(2),
          thisMonthEarnings: parseFloat(thisMonthEarnings).toFixed(2)
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
      const userId = req.user.id;
      const [txRows] = await pool.query(
        `SELECT transaction_id AS id, COALESCE(title, type) AS title, category, type, amount, COALESCE(status, 'Completed') AS status, payment_channel, reference_code, created_at FROM transactions WHERE user_id = ?`, 
        [userId]
      );

      let depositRows = [];
      try {
        const [dRows] = await pool.query(
          `SELECT id, CONCAT('Recharge (', COALESCE(transaction_id, reference, id), ')') AS title, 'recharge' AS category, 'deposit' AS type, amount, COALESCE(status, 'pending') AS status, channel AS payment_channel, reference AS reference_code, created_at FROM deposits WHERE user_id = ?`,
          [userId]
        );
        depositRows = dRows;
      } catch (e) {
        console.warn('Deposits table query failed:', e.message);
      }

      let withdrawalRows = [];
      try {
        const [wRows] = await pool.query(
          `SELECT id, CONCAT('Withdrawal (', method, ')') AS title, 'withdrawal' AS category, 'withdrawal' AS type, amount, COALESCE(status, 'pending') AS status, method AS payment_channel, account_info AS reference_code, created_at FROM withdrawals WHERE user_id = ?`,
          [userId]
        );
        withdrawalRows = wRows;
      } catch (e) {
        console.warn('Withdrawals table query failed:', e.message);
      }

      const allRecords = [...txRows, ...depositRows, ...withdrawalRows];
      allRecords.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      res.json({ success: true, records: allRecords });
    } catch (err) {
      console.error('Accounting fatal error:', err);
      res.status(500).json({ success: false, message: err.message });
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

  const getRechargeHistoryHandler = async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, amount, channel, transaction_id, reference, proof_image, status, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC',
        [req.user.id]
      ).catch(() => [[]]);

      res.json({ success: true, records: rows, history: rows });
    } catch (err) {
      console.error('Recharge history fetch error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch recharge records' });
    }
  };

  router.get('/recharge/history', verifyToken, getRechargeHistoryHandler);
  router.get('/recharge/records', verifyToken, getRechargeHistoryHandler);
  router.get('/user/recharge-records', verifyToken, getRechargeHistoryHandler);

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
    const { amount, handlingFee, netAmountToReceive, method, accountDetails, accountNumber, fundPassword } = req.body;
    const withdrawalAmount = parseFloat(amount);

    // Enforce minimum withdrawal limit of 20 GHS
    if (!withdrawalAmount || withdrawalAmount < 20) {
      return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is 20.00 GHS.' });
    }
    
    try {
      // Fetch user balance and fund_password hash
      const [userRows] = await pool.query('SELECT balance, fund_password FROM users WHERE user_id = ?', [req.user.id]);
      if (userRows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
      
      const user = userRows[0];
      const currentBalance = user.balance;
      const totalDeduction = withdrawalAmount;

      if (currentBalance < totalDeduction) {
        return res.status(400).json({ success: false, message: 'Insufficient balance for withdrawal' });
      }

      // Verify Fund Password if set in system
      if (user.fund_password) {
        if (!fundPassword) {
          return res.status(400).json({ success: false, message: 'Please enter your fund password.' });
        }
        const isMatch = await bcrypt.compare(fundPassword, user.fund_password);
        if (!isMatch) {
          return res.status(400).json({ success: false, message: 'Incorrect fund password.' });
        }
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [totalDeduction, req.user.id]);
        await connection.query(
          'INSERT INTO withdrawals (user_id, amount, fee, net_amount, method, account_info, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", NOW())',
          [req.user.id, withdrawalAmount, handlingFee || 0, netAmountToReceive || withdrawalAmount, method || 'Bank', accountNumber || accountDetails || '']
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
      console.error('Withdrawal error:', err);
      res.status(500).json({ success: false, message: err.message || 'Server error processing withdrawal' });
    }
  };

  router.post('/withdraw/request', verifyToken, handleWithdrawalRequest);
  router.post('/withdraw/submit', verifyToken, handleWithdrawalRequest);
  router.post('/user/withdraw', verifyToken, handleWithdrawalRequest);
  router.post('/wallet/withdraw', verifyToken, handleWithdrawalRequest);

  // 7. FUND INVESTMENTS & SUMMARY & RECORDS
  router.get('/fund/summary', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;

      // Auto-settle matured investments
      const [maturedInvestments] = await pool.query(
        'SELECT * FROM user_investments WHERE user_id = ? AND status = "active" AND ends_at <= NOW()',
        [userId]
      );

      for (const inv of maturedInvestments) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query('UPDATE user_investments SET status = "completed" WHERE investment_id = ?', [inv.investment_id]);
          const payout = parseFloat(inv.expected_revenue || 0);
          await connection.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [payout, userId]);
          await connection.commit();
          connection.release();
        } catch (txErr) {
          await connection.rollback();
          connection.release();
        }
      }

      const [investments] = await pool.query(
        `SELECT ui.*, COALESCE(wp.daily_profit_percentage, 2.00) AS daily_profit_percentage, COALESCE(wp.duration_days, 3) AS duration_days, COALESCE(wp.plan_name, 'Investment Plan') AS plan_name 
         FROM user_investments ui 
         LEFT JOIN wealth_plans wp ON ui.plan_id = wp.plan_id 
         WHERE ui.user_id = ? ORDER BY ui.started_at DESC`, 
        [userId]
      );
      
      const [users] = await pool.query('SELECT balance FROM users WHERE user_id = ?', [userId]);

      let activeInvested = 0;
      let todaysEarnings = 0;

      investments.forEach(inv => {
        if (inv.status && inv.status.toLowerCase() === 'active') {
          const invested = parseFloat(inv.invested_amount || 0);
          activeInvested += invested;

          const profitPercent = parseFloat(inv.daily_profit_percentage) || 2.00;
          const durationDays = parseInt(inv.duration_days) || 3;
          
          const totalProfit = invested * (profitPercent / 100);
          todaysEarnings += totalProfit / durationDays;
        }
      });

      res.json({ 
        success: true, 
        balance: users.length > 0 ? users[0].balance : 0,
        summary: {
          activeInvested: activeInvested.toFixed(2),
          todaysEarnings: todaysEarnings.toFixed(2)
        },
        activeInvested: activeInvested.toFixed(2),
        todaysEarnings: todaysEarnings.toFixed(2),
        investments: investments 
      });
    } catch (err) {
      console.error('Error fetching fund summary:', err);
      res.status(500).json({ success: false, message: 'Server error fetching fund summary' });
    }
  });

  router.post('/fund/invest', verifyToken, async (req, res) => {
    const { amount, planId, fundId, expected_revenue, days } = req.body;
    const targetPlanId = planId || fundId || 1;
    const investAmount = parseFloat(amount);

    if (!investAmount || investAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid investment amount' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [userRows] = await connection.query('SELECT balance FROM users WHERE user_id = ? FOR UPDATE', [req.user.id]);
      if (userRows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const currentBalance = parseFloat(userRows[0].balance);
      if (currentBalance < investAmount) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ success: false, message: 'Insufficient balance for this investment' });
      }

      const [planRows] = await connection.query('SELECT plan_name FROM wealth_plans WHERE plan_id = ?', [targetPlanId]);
      const planName = planRows.length > 0 ? planRows[0].plan_name : `Plan #${targetPlanId}`;

      await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [investAmount, req.user.id]);

      const calculatedRevenue = expected_revenue || (investAmount * 1.5);
      const durationDays = parseInt(days) || 3;

      await connection.query(
        `INSERT INTO user_investments (user_id, plan_id, invested_amount, expected_revenue, status, started_at, ends_at) 
         VALUES (?, ?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
        [req.user.id, targetPlanId, investAmount, calculatedRevenue, durationDays]
      );

      try {
        await connection.query(
          `INSERT INTO transactions (user_id, title, category, type, amount, status, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [req.user.id, `${planName} Purchase`, 'investment', 'investment_purchase', -investAmount, 'Completed']
        );
      } catch (txInsertErr) {
        console.warn('Non-fatal: Failed to insert transaction record:', txInsertErr.message);
      }

      await connection.commit();
      connection.release();

      res.json({ success: true, message: 'Investment submitted successfully!' });
    } catch (err) {
      await connection.rollback();
      connection.release();
      console.error('Fund invest error:', err);
      res.status(500).json({ success: false, message: 'Server error processing investment' });
    }
  });

  // 8. DYNAMIC WEALTH PLANS & RECORDS API
  const getWealthPlansHandler = async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM wealth_plans ORDER BY plan_id ASC');
      res.json({ success: true, data: rows, plans: rows });
    } catch (err) {
      console.error('Error fetching wealth plans:', err);
      res.status(500).json({ success: false, message: 'Server error fetching wealth plans' });
    }
  };

  router.get('/wealth-plans', verifyToken, getWealthPlansHandler);
  router.get('/fund/plans', verifyToken, getWealthPlansHandler);
  router.get('/plans', verifyToken, getWealthPlansHandler);

  const getFundRecordsHandler = async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT investment_id AS id, plan_id, invested_amount, expected_revenue, status, started_at, ends_at FROM user_investments WHERE user_id = ? ORDER BY started_at DESC',
        [req.user.id]
      );
      res.json({ success: true, data: rows, records: rows });
    } catch (err) {
      console.error('Error fetching fund records:', err);
      res.status(500).json({ success: false, message: 'Server error fetching records' });
    }
  };

  router.get('/fund/records', verifyToken, getFundRecordsHandler);
  router.get('/fund/my-investments', verifyToken, getFundRecordsHandler);
  router.get('/fund/my-plans', verifyToken, getFundRecordsHandler);

  return router;
}

module.exports = userRoutes;