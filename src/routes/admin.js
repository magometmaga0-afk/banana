const router = require('express').Router();
const { pool, logActivity } = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get('/dashboard', async (req, res) => {
    try {
        const [users, logs, stats, transactions] = await Promise.all([
            pool.query(`SELECT id, username, email, created_at, banned, banned_at, role, verified,
                               passport_full_name, passport_number, passport_submitted_at
                        FROM users ORDER BY created_at DESC`),
            pool.query('SELECT id, user_id, email, action, status, ip, details, created_at FROM activity_logs ORDER BY created_at DESC LIMIT 500'),
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE action = 'register')                     AS total_registrations,
                    COUNT(*) FILTER (WHERE action = 'login' AND status = 'success') AS successful_logins,
                    COUNT(*) FILTER (WHERE action = 'login' AND status = 'failed')  AS failed_logins,
                    COUNT(*) FILTER (WHERE action = 'password_reset')               AS password_resets,
                    (SELECT COUNT(*)                                                   FROM transactions) AS total_tx,
                    (SELECT COALESCE(SUM(amount) FILTER (WHERE type='transfer'), 0)   FROM transactions) AS total_volume
                FROM activity_logs
            `),
            pool.query(`
                SELECT t.id, t.type, t.amount, t.description, t.created_at, t.status,
                    su.username AS sender_username, su.email AS sender_email,
                    ru.username AS receiver_username, ru.email AS receiver_email
                FROM transactions t
                LEFT JOIN users su ON t.sender_id   = su.id
                LEFT JOIN users ru ON t.receiver_id = ru.id
                ORDER BY t.created_at DESC
                LIMIT 300
            `),
        ]);
        res.json({
            users:        users.rows,
            logs:         logs.rows,
            stats:        stats.rows[0],
            transactions: transactions.rows,
        });
    } catch (err) {
        console.error('admin/dashboard:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/users/:id/ban', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID' });
    try {
        const { rows } = await pool.query(
            'UPDATE users SET banned = true, banned_at = NOW() WHERE id = $1 RETURNING username, email',
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
        await logActivity(rows[0].email, 'ban', 'success', req.ip, `Banned by admin`);
        console.log(`🚫 Бан: ${rows[0].username} (${rows[0].email})`);
        res.json({ success: true });
    } catch (err) {
        console.error('admin/ban:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/users/:id/unban', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID' });
    try {
        const { rows } = await pool.query(
            'UPDATE users SET banned = false, banned_at = NULL WHERE id = $1 RETURNING username, email',
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
        await logActivity(rows[0].email, 'unban', 'success', req.ip, `Unbanned by admin`);
        console.log(`✅ Разбан: ${rows[0].username} (${rows[0].email})`);
        res.json({ success: true });
    } catch (err) {
        console.error('admin/unban:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/users/:id/role', async (req, res) => {
    const id   = parseInt(req.params.id);
    const role = req.body.role;
    if (!id) return res.status(400).json({ error: 'Неверный ID' });
    if (!['trader', 'casino', 'admin'].includes(role))
        return res.status(400).json({ error: 'Неверная роль' });
    try {
        const { rows } = await pool.query(
            'UPDATE users SET role=$1 WHERE id=$2 RETURNING username, email',
            [role, id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
        await logActivity(rows[0].email, 'role_change', 'success', req.ip, `role → ${role}`);
        console.log(`🎭 Смена роли: ${rows[0].username} → ${role}`);
        res.json({ success: true });
    } catch (err) {
        console.error('admin/role:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/users/:id/verify', async (req, res) => {
    const id       = parseInt(req.params.id);
    const approved = req.body.verified !== false; // по умолчанию — одобрить
    if (!id) return res.status(400).json({ error: 'Неверный ID' });
    try {
        const { rows } = await pool.query(
            `UPDATE users SET verified=$1 WHERE id=$2 AND passport_submitted_at IS NOT NULL
             RETURNING username, email`,
            [approved, id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Паспорт не подан' });
        await logActivity(rows[0].email, approved ? 'kyc_approve' : 'kyc_reject', 'success', req.ip, `by admin`);
        console.log(`🛂 ${approved ? 'Верификация одобрена' : 'Верификация отклонена'}: ${rows[0].username} (${rows[0].email})`);
        res.json({ success: true });
    } catch (err) {
        console.error('admin/verify:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.delete('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT username, email FROM users WHERE id = $1', [id]);
        if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Пользователь не найден' }); }

        // Удаляем зависимые записи вручную (на случай если constraints без CASCADE)
        await client.query('DELETE FROM trader_methods   WHERE user_id    = $1', [id]);
        await client.query('DELETE FROM sessions         WHERE user_id    = $1', [id]);
        await client.query('UPDATE  transactions SET sender_id   = NULL WHERE sender_id   = $1', [id]);
        await client.query('UPDATE  transactions SET receiver_id = NULL WHERE receiver_id = $1', [id]);
        await client.query('UPDATE  activity_logs SET user_id   = NULL WHERE user_id     = $1', [id]);
        await client.query('DELETE FROM wallets          WHERE user_id    = $1', [id]);
        await client.query('DELETE FROM users            WHERE id         = $1', [id]);

        await client.query('COMMIT');
        console.log(`🗑️  Удалён: ${rows[0].username} (${rows[0].email})`);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('admin/delete:', err.message);
        res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;