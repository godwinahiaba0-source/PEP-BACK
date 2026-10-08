// ==========================================
// INVESTMENT EXPIRY & PAYOUT WORKER
// ==========================================

function initInvestmentWorker(pool) {
  // Run every 1 minute to check for expired investments
  setInterval(async () => {
    try {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // 1. Find all active investments that have reached or passed their end date
        const [expiredInvestments] = await connection.query(
          `SELECT investment_id, user_id, expected_revenue FROM user_investments WHERE status = 'active' AND ends_at <= NOW()`
        );

        for (const inv of expiredInvestments) {
          // 2. Add expected revenue to user's balance
          await connection.query(
            'UPDATE users SET balance = balance + ? WHERE user_id = ?',
            [inv.expected_revenue, inv.user_id]
          );

          // 3. Mark investment as completed
          await connection.query(
            "UPDATE user_investments SET status = 'completed' WHERE investment_id = ?",
            [inv.investment_id]
          );

          // 4. Log the payout into transactions table safely
          await connection.query(
            `INSERT INTO transactions (user_id, title, category, type, amount, status, created_at) 
             VALUES (?, 'Investment Payout', 'investment', 'yield', ?, 'Completed', NOW())`,
            [inv.user_id, inv.expected_revenue]
          ).catch(() => {});
        }

        await connection.commit();s
        connection.release();
      } catch (txErr) {
        await connection.rollback();
        connection.release();
      }
    } catch (err) {
      // Connection error catcher
    }
  }, 60 * 1000); // Runs every 1 minute
}

module.exports = { initInvestmentWorker };