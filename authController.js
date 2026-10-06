const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper function to generate a random 6-digit referral code (e.g., 849201)
function generateReferralCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Register a new user and assign a unique referral code & Level 0 Free Trial Device
const register = async (req, res, db) => {
    const { phone, password, referralCode } = req.body; // referralCode entered during signup
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Check total user count to see if this is the very first account
        const [countResult] = await connection.execute(`SELECT COUNT(*) as total FROM users`);
        const userCount = countResult[0].total;

        // 2. Check if user already exists
        const [existingUser] = await connection.execute(
            `SELECT user_id FROM users WHERE phone = ?`, 
            [phone]
        );
        if (existingUser.length > 0) {
            throw new Error('Phone number already registered');
        }

        // 3. Resolve Referrer ID (Bypassed if this is the first user in an empty database)
        let referrerId = null;
        if (userCount > 0) {
            if (!referralCode) {
                throw new Error('Invitation code is required');
            }
            const [referrerRows] = await connection.execute(
                `SELECT user_id FROM users WHERE referral_code = ?`,
                [referralCode]
            );
            if (referrerRows.length === 0) {
                throw new Error('Invalid referral code');
            }
            referrerId = referrerRows[0].user_id;
        }

        // 4. Generate a unique 6-digit referral code for the new user
        let newReferralCode;
        let isUnique = false;
        while (!isUnique) {
            newReferralCode = generateReferralCode();
            const [codeCheck] = await connection.execute(
                `SELECT user_id FROM users WHERE referral_code = ?`,
                [newReferralCode]
            );
            if (codeCheck.length === 0) {
                isUnique = true;
            }
        }

        // 5. Hash the password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // 6. Insert the new user into the database with their generated referral code & referrerId
        const [result] = await connection.execute(
            `INSERT INTO users (phone, password_hash, balance, vip_level, referral_code, invited_by) VALUES (?, ?, 0.00, 0, ?, ?)`,
            [phone, passwordHash, newReferralCode, referrerId]
        );
        const newUserId = result.insertId;

        // ==========================================
        // 7. ASSIGN LEVEL 0 FREE TRIAL (24 HOURS)
        // ==========================================
        // Gives 0.25 every hour for 24 hours. Stops automatically when expires_at passes 
        // or when they purchase a new device.
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await connection.execute(
            `INSERT INTO user_devices (user_id, device_id, purchase_price, hourly_yield, status, payout_count, expires_at) 
             VALUES (?, 0, 0.00, 0.25, 'ACTIVE', 0, ?)`,
            [newUserId, expiresAt]
        );

        // ==========================================
        // 8. HANDLE MULTI-LEVEL REFERRAL NETWORK
        // ==========================================
        if (referrerId) {
            // Level 1: Direct upline
            await connection.execute(
                `INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 1)`,
                [referrerId, newUserId]
            );

            // Level 2: Find Level 1's upline
            const [level1Rows] = await connection.execute(
                `SELECT ancestor_user_id FROM team_referrals WHERE descendant_user_id = ? AND level = 1`,
                [referrerId]
            );
            if (level1Rows.length > 0) {
                const level2Ancestor = level1Rows[0].ancestor_user_id;
                await connection.execute(
                    `INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 2)`,
                    [level2Ancestor, newUserId]
                );

                // Level 3: Find Level 2's upline
                const [level2Rows] = await connection.execute(
                    `SELECT ancestor_user_id FROM team_referrals WHERE descendant_user_id = ? AND level = 1`,
                    [level2Ancestor]
                );
                if (level2Rows.length > 0) {
                    const level3Ancestor = level2Rows[0].ancestor_user_id;
                    await connection.execute(
                        `INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 3)`,
                        [level3Ancestor, newUserId]
                    );
                }
            }
        }

        await connection.commit();
        res.status(201).json({ 
            success: true, 
            message: 'Account created successfully',
            userId: newUserId,
            referralCode: newReferralCode
        });

    } catch (error) {
        await connection.rollback();
        console.error('Registration error:', error.message);
        res.status(400).json({ success: false, message: error.message || 'Server error' });
    } finally {
        connection.release();
    }
};

// Login user
const login = async (req, res, db, JWT_SECRET) => {
    const { phone, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
        if (users.length === 0) return res.status(400).json({ success: false, message: 'Invalid phone or password' });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid phone or password' });

        const token = jwt.sign({ id: user.user_id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, referralCode: user.referral_code });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { register, login };