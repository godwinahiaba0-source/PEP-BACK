// ==========================================
// TEAM REPORT & METRICS CONTROLLER (Using deposits & withdrawals tables)
// ==========================================

const getTeamReport = async (req, res, db) => {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    const connection = await db.getConnection();
    try {
        // Fetch all downlines categorized by level directly from the team_referrals table[cite: 10]
        const [referralRows] = await connection.execute(
            `SELECT descendant_user_id, level FROM team_referrals WHERE ancestor_user_id = ? AND level IN (1, 2, 3)`,
            [userId]
        );

        const level1Ids = referralRows.filter(r => r.level === 1).map(r => r.descendant_user_id);
        const level2Ids = referralRows.filter(r => r.level === 2).map(r => r.descendant_user_id);
        const level3Ids = referralRows.filter(r => r.level === 3).map(r => r.descendant_user_id);

        const levelsMap = {
            1: level1Ids,
            2: level2Ids,
            3: level3Ids
        };

        let totalTeamRecharge = 0;
        let totalTeamWithdraw = 0;
        let totalFirstChargeCount = 0;
        let totalFirstPushCount = level1Ids.length; // Direct Level 1 invites/pushes
        
        const allTeamIds = referralRows.map(r => r.descendant_user_id);
        const totalTeamSize = allTeamIds.length;
        let totalNewTeamCount = totalTeamSize;

        const levelDetails = {};

        for (let lvl = 1; lvl <= 3; lvl++) {
            const ids = levelsMap[lvl];
            let lvlRechargeAmount = 0;
            let lvlRechargeNumber = 0;

            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                
                // Calculate total approved recharges for this specific level from the deposits table
                const [rechargeRows] = await connection.execute(
                    `SELECT COALESCE(SUM(amount), 0) as total_recharge, COUNT(DISTINCT user_id) as recharge_count 
                     FROM deposits 
                     WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                    ids
                );
                
                lvlRechargeAmount = parseFloat(rechargeRows[0].total_recharge || 0);
                lvlRechargeNumber = parseInt(rechargeRows[0].recharge_count || 0, 10);
            }

            levelDetails[lvl] = {
                rechargeAmount: lvlRechargeAmount,
                rechargeNumber: lvlRechargeNumber
            };
        }

        // Global team financial metrics across all levels (1, 2, 3)
        if (allTeamIds.length > 0) {
            const placeholders = allTeamIds.map(() => '?').join(',');

            const [globalRecharge] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            );
            totalTeamRecharge = parseFloat(globalRecharge[0].total || 0);

            const [globalWithdraw] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            );
            totalTeamWithdraw = parseFloat(globalWithdraw[0].total || 0);

            const [firstCharge] = await connection.execute(
                `SELECT COUNT(DISTINCT user_id) as cnt FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            );
            totalFirstChargeCount = parseInt(firstCharge[0].cnt || 0, 10);
        }

        res.json({
            success: true,
            teamRecharge: totalTeamRecharge,
            firstChargeCount: totalFirstChargeCount,
            teamSize: totalTeamSize,
            teamWithdraw: totalTeamWithdraw,
            firstPushCount: totalFirstPushCount,
            newTeamCount: totalNewTeamCount,
            levels: levelDetails
        });

    } catch (err) {
        console.error('Team report error:', err);
        res.status(500).json({ success: false, message: 'Failed to generate team report' });
    } finally {
        connection.release();
    }
};

module.exports = { getTeamReport };