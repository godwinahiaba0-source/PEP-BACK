const cron = require('node-cron');

// Setup the hourly cron job worker (Runs 24/7 with VIP 0 Free Payouts, Device Yields & 3-Level Hourly Commissions)
function initDeviceWorker(db) {
    cron.schedule('0 * * * *', async () => {
        console.log('⏰ Running hourly yield payout & referral commission worker...');
        
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // ==========================================
            // 1. PROCESS VIP LEVEL 0 FREE CREDITS
            // ==========================================
            const [vipZeroUsers] = await connection.execute(
                `SELECT ud.user_device_id, ud.user_id, ud.hourly_yield
                 FROM user_devices ud
                 JOIN users u ON ud.user_id = u.user_id
                 WHERE u.vip_level = 0 
                   AND ud.status = 'ACTIVE'`
            );

            for (const device of vipZeroUsers) {
                const earnings = parseFloat(device.hourly_yield || 0.25);

                // Credit user balance
                await connection.execute(
                    `UPDATE users SET balance = balance + ? WHERE user_id = ?`,
                    [earnings, device.user_id]
                );

                // Log transaction for accounting records
                await connection.execute(
                    `INSERT INTO transactions (user_id, title, description, type, amount, status, created_at) VALUES (?, 'Hourly Yield', 'Free VIP 0 device yield payout', 'yield', ?, 'success', NOW())`,
                    [device.user_id, earnings]
                ).catch(() => {});
            }

            // ==========================================
            // 2. PROCESS PAID DEVICES & 3-LEVEL HOURLY COMMISSIONS
            // ==========================================
            const [activeDevices] = await connection.execute(
                `SELECT ud.user_device_id, ud.user_id, ud.hourly_yield, 
                        COALESCE(vd.id, 0) as device_tier_id
                 FROM user_devices ud 
                 JOIN users u ON ud.user_id = u.user_id
                 LEFT JOIN vip_devices vd ON ud.device_id = vd.id
                 WHERE u.vip_level > 0 AND ud.status = 'ACTIVE'`
            );

            for (const device of activeDevices) {
                if (!device.user_id || device.hourly_yield == null) continue;

                // Credit base hourly yield to device owner
                await connection.execute(
                    `UPDATE users SET balance = balance + ? WHERE user_id = ?`,
                    [device.hourly_yield, device.user_id]
                );

                await connection.execute(
                    `INSERT INTO transactions (user_id, title, description, type, amount, status, created_at) VALUES (?, 'Device Yield', 'Hourly VIP device payout', 'yield', ?, 'success', NOW())`,
                    [device.user_id, device.hourly_yield]
                );

                // ==========================================
                // 3-LEVEL HOURLY COMMISSION PROCESSING
                // ==========================================
                let currentUserId = device.user_id;
                const commissionRates = [0.05, 0.022, 0.011]; // Level 1 (5%), Level 2 (2.2%), Level 3 (1.1%)

                for (let level = 0; level < 3; level++) {
                    const [uplineRows] = await connection.execute(
                        `SELECT u.user_id, u.balance, u.total_team_benefits, 
                         (SELECT MAX(vd_inner.id) FROM user_devices ud_inner 
                          JOIN vip_devices vd_inner ON ud_inner.device_id = vd_inner.id 
                          WHERE ud_inner.user_id = u.user_id AND ud_inner.status = 'ACTIVE') as max_device_tier
                         FROM team_referrals tr
                         JOIN users u ON tr.ancestor_user_id = u.user_id
                         WHERE tr.descendant_user_id = ? AND tr.level = ?`,
                        [currentUserId, level + 1]
                    );

                    if (uplineRows.length === 0) break;
                    const upline = uplineRows[0];
                    currentUserId = upline.user_id;

                    const commissionAmount = device.hourly_yield * commissionRates[level];
                    if (commissionAmount <= 0) continue;

                    const uplineMaxTier = upline.max_device_tier || 0;
                    const downlineTier = device.device_tier_id || 0;

                    if (uplineMaxTier >= downlineTier) {
                        await connection.execute(
                            `UPDATE users SET balance = balance + ? WHERE user_id = ?`,
                            [commissionAmount, upline.user_id]
                        );
                        await connection.execute(
                            `INSERT INTO transactions (user_id, title, description, type, amount, status, created_at) VALUES (?, 'Team Commission', 'Level ${level + 1} hourly team commission', 'commission', ?, 'success', NOW())`,
                            [upline.user_id, commissionAmount]
                        );
                    } else {
                        await connection.execute(
                            `UPDATE users SET total_team_benefits = total_team_benefits + ? WHERE user_id = ?`,
                            [commissionAmount, upline.user_id]
                        );
                    }
                }
            }

            await connection.commit();
            console.log(`✅ Processed payouts & commissions for ${vipZeroUsers.length} VIP 0 users and ${activeDevices.length} paid devices.`);
        } catch (error) {
            await connection.rollback();
            console.error('❌ Payout & Commission error:', error);
        } finally {
            connection.release();
        }
    });
}

// Handle device purchase logic & Instant Referral Rebates & VIP Level Update
const buyDevice = async (req, res, db) => {
    const userId = req.user?.id || req.user?.userId || req.body.userId;
    const deviceId = req.body.device_id || req.body.deviceId;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized: User ID missing from token' });
    }
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'Device ID is required' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Get device details
        const [devices] = await connection.execute(
            `SELECT id, name, price, hourly_yield FROM vip_devices WHERE id = ?`,
            [deviceId]
        );
        if (devices.length === 0) throw new Error('Device not found');
        const device = devices[0];
        const devicePrice = parseFloat(device.price);

        // 2. Get user balance
        const [users] = await connection.execute(
            `SELECT balance FROM users WHERE user_id = ? FOR UPDATE`,
            [userId]
        );
        if (users.length === 0) throw new Error('User not found');
        if (users[0].balance < devicePrice) throw new Error('Insufficient balance');

        // 3. Deduct balance and assign device
        await connection.execute(
            `UPDATE users SET balance = balance - ? WHERE user_id = ?`,
            [devicePrice, userId]
        );

        await connection.execute(
            `INSERT INTO user_devices (user_id, device_id, purchase_price, hourly_yield, status) VALUES (?, ?, ?, ?, 'ACTIVE')`,
            [userId, deviceId, devicePrice, device.hourly_yield]
        );

        // 4. Recalculate and update buyer's max VIP Level based on active devices
        const [maxTierResult] = await connection.execute(
            `SELECT COALESCE(MAX(vd.id), 0) as max_tier 
             FROM user_devices ud 
             JOIN vip_devices vd ON ud.device_id = vd.id 
             WHERE ud.user_id = ? AND ud.status = 'ACTIVE'`,
            [userId]
        );
        const newVipLevel = maxTierResult[0].max_tier;

        await connection.execute(
            `UPDATE users SET vip_level = ? WHERE user_id = ?`,
            [newVipLevel, userId]
        );

        // Log purchase as a debit transaction (negative amount)
        await connection.execute(
            `INSERT INTO transactions (user_id, title, description, type, amount, status, created_at) VALUES (?, 'Device Purchase', 'Purchased VIP device: ${device.name}', 'BUY_DEVICE', ?, 'success', NOW())`,
            [userId, -devicePrice]
        );

        // ==========================================
        // 5. MULTI-LEVEL INSTANT REFERRAL REBATES
        // ==========================================
        const rebateRates = { 1: 0.10, 2: 0.05, 3: 0.03 };
        const [uplines] = await connection.execute(
            `SELECT ancestor_user_id, level FROM team_referrals WHERE descendant_user_id = ? AND level IN (1, 2, 3)`,
            [userId]
        );

        for (const upline of uplines) {
            const uplineId = upline.ancestor_user_id;
            const level = upline.level;
            const rate = rebateRates[level] || 0;

            if (rate > 0) {
                const [uplineDevices] = await connection.execute(
                    `SELECT COALESCE(MAX(d.price), 0) as max_price 
                     FROM user_devices ud 
                     JOIN vip_devices d ON ud.device_id = d.id 
                     WHERE ud.user_id = ?`,
                    [uplineId]
                );
                const uplineMaxDevicePrice = parseFloat(uplineDevices[0].max_price || 0);

                if (uplineMaxDevicePrice >= devicePrice) {
                    const rebateAmount = devicePrice * rate;

                    await connection.execute(
                        `UPDATE users SET balance = balance + ?, referral_rebate = referral_rebate + ? WHERE user_id = ?`,
                        [rebateAmount, rebateAmount, uplineId]
                    );

                    await connection.execute(
                        `INSERT INTO transactions (user_id, title, description, type, amount, status, created_at) VALUES (?, 'Referral Rebate', 'Level ${level} referral rebate from device purchase', 'REFERRAL_REBATE', ?, 'success', NOW())`,
                        [uplineId, rebateAmount]
                    );
                }
            }
        }

        await connection.commit();
        res.json({ 
            success: true, 
            message: `Successfully purchased ${device.name} and distributed referral rebates!`,
            vipLevel: newVipLevel 
        });

    } catch (error) {
        await connection.rollback();
        console.error('Purchase error:', error.message);
        res.status(400).json({ success: false, message: error.message || 'Server error' });
    } finally {
        connection.release();
    }
};

module.exports = { initDeviceWorker, buyDevice };