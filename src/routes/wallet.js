const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const { pool, logActivity } = require('../db');
const { requireAuth } = require('../middleware/auth');

const walletLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Слишком много запросов. Подождите минуту' },
});

const transferLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Слишком много переводов. Подождите минуту' },
});

// Единый init-эндпоинт: баланс + статистика + транзакции за 1 запрос
router.get('/init', walletLimiter, requireAuth, async (req, res) => {
    try {
        const uid = req.user.id;
        const [meRow, txRows] = await Promise.all([
            pool.query(`
                WITH w AS (SELECT balance FROM wallets WHERE user_id = $1),
                s AS (
                    SELECT
                        COALESCE(SUM(amount) FILTER (WHERE receiver_id=$1 AND type='transfer'),   0) AS total_received,
                        COALESCE(SUM(amount) FILTER (WHERE sender_id  =$1 AND type='transfer'),   0) AS total_sent,
                        COALESCE(SUM(amount) FILTER (WHERE receiver_id=$1 AND type='deposit'),    0) AS total_deposited,
                        COALESCE(SUM(amount) FILTER (WHERE sender_id  =$1 AND type='withdrawal'), 0) AS total_withdrawn,
                        COUNT(*) FILTER (WHERE sender_id=$1 OR receiver_id=$1)                       AS tx_count
                    FROM transactions WHERE sender_id=$1 OR receiver_id=$1
                ),
                u AS (SELECT username, email, role, verified FROM users WHERE id = $1)
                SELECT w.balance, s.*, u.username, u.email, u.role, u.verified FROM w, s, u
            `, [uid]),
            pool.query(`
                SELECT t.id, t.type, t.amount, t.description, t.created_at, t.status,
                    t.sender_id, t.receiver_id,
                    su.username AS sender_username, su.email AS sender_email,
                    ru.username AS receiver_username, ru.email AS receiver_email
                FROM transactions t
                LEFT JOIN users su ON t.sender_id   = su.id
                LEFT JOIN users ru ON t.receiver_id = ru.id
                WHERE t.sender_id = $1 OR t.receiver_id = $1
                ORDER BY t.created_at DESC
                LIMIT 100
            `, [uid]),
        ]);

        res.json({
            username:     meRow.rows[0]?.username ?? req.user.username,
            email:        meRow.rows[0]?.email    ?? req.user.email,
            role:         meRow.rows[0]?.role     ?? req.user.role ?? 'trader',
            verified:     meRow.rows[0]?.verified ?? false,
            balance:      meRow.rows[0]?.balance  ?? '0.00',
            stats:        meRow.rows[0],
            transactions: txRows.rows.map(tx => ({
                ...tx,
                direction: tx.type === 'deposit'    ? 'in'
                         : tx.type === 'withdrawal' ? 'out'
                         : tx.sender_id === uid ? 'out' : 'in',
            })),
        });
    } catch (err) {
        console.error('wallet/init:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.get('/me', requireAuth, async (req, res) => {
    try {
        // Одним запросом: баланс + статистика через CTE
        const { rows } = await pool.query(`
            WITH w AS (
                SELECT balance FROM wallets WHERE user_id = $1
            ),
            s AS (
                SELECT
                    COALESCE(SUM(amount) FILTER (WHERE receiver_id = $1 AND type = 'transfer'),   0) AS total_received,
                    COALESCE(SUM(amount) FILTER (WHERE sender_id   = $1 AND type = 'transfer'),   0) AS total_sent,
                    COALESCE(SUM(amount) FILTER (WHERE receiver_id = $1 AND type = 'deposit'),    0) AS total_deposited,
                    COALESCE(SUM(amount) FILTER (WHERE sender_id   = $1 AND type = 'withdrawal'), 0) AS total_withdrawn,
                    COUNT(*) FILTER (WHERE sender_id = $1 OR receiver_id = $1)                       AS tx_count
                FROM transactions WHERE sender_id = $1 OR receiver_id = $1
            )
            SELECT w.balance, s.* FROM w, s
        `, [req.user.id]);

        res.json({
            username: req.user.username,
            email:    req.user.email,
            balance:  rows[0]?.balance ?? '0.00',
            stats:    rows[0],
        });
    } catch (err) {
        console.error('wallet/me:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.get('/transactions', walletLimiter, requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                t.id, t.type, t.amount, t.description, t.created_at, t.status,
                t.sender_id, t.receiver_id,
                su.username AS sender_username, su.email AS sender_email,
                ru.username AS receiver_username, ru.email AS receiver_email
            FROM transactions t
            LEFT JOIN users su ON t.sender_id   = su.id
            LEFT JOIN users ru ON t.receiver_id = ru.id
            WHERE t.sender_id = $1 OR t.receiver_id = $1
            ORDER BY t.created_at DESC
            LIMIT 100
        `, [req.user.id]);

        const data = rows.map(tx => ({
            ...tx,
            direction: tx.type === 'deposit'    ? 'in'
                     : tx.type === 'withdrawal' ? 'out'
                     : tx.sender_id === req.user.id ? 'out' : 'in',
        }));
        res.json(data);
    } catch (err) {
        console.error('wallet/transactions:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.get('/find-user', walletLimiter, requireAuth, async (req, res) => {
    const q = (req.query.q || '').trim().replace(/^@/, '').toLowerCase();
    if (!q || q.length < 2) return res.json({ found: false });
    try {
        const { rows } = await pool.query(
            `SELECT id, username, email FROM users
             WHERE (email = $1 OR LOWER(username) = $1) AND id != $2 AND banned = false
             LIMIT 1`,
            [q, req.user.id]
        );
        if (!rows.length) return res.json({ found: false });
        res.json({ found: true, id: rows[0].id, username: rows[0].username, email: rows[0].email });
    } catch (err) {
        console.error('wallet/find-user:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/deposit', walletLimiter, requireAuth, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0 || amount > 100_000)
        return res.status(400).json({ success: false, error: 'Некорректная сумма (max $100 000)' });

    try {
        const { rows } = await pool.query(
            `UPDATE wallets SET balance = balance + $1, updated_at = NOW()
             WHERE user_id = $2 RETURNING balance`,
            [amount, req.user.id]
        );
        // fire-and-forget — не задерживаем ответ
        pool.query(
            'INSERT INTO transactions (receiver_id, amount, type, description) VALUES ($1,$2,$3,$4)',
            [req.user.id, amount, 'deposit', 'Пополнение баланса']
        ).catch(err => console.error('tx insert:', err.message));
        logActivity(req.user.email, 'deposit', 'success', req.ip, `+$${amount}`);
        console.log(`💰 Пополнение: ${req.user.username} +$${amount} | баланс: $${rows[0].balance}`);

        res.json({ success: true, balance: rows[0].balance });
    } catch (err) {
        console.error('wallet/deposit:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

router.post('/withdraw', walletLimiter, requireAuth, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0)
        return res.status(400).json({ success: false, error: 'Некорректная сумма' });

    try {
        // Атомарный UPDATE — проверка баланса и списание в одном запросе
        const { rows } = await pool.query(
            `UPDATE wallets SET balance = balance - $1, updated_at = NOW()
             WHERE user_id = $2 AND balance >= $1
             RETURNING balance`,
            [amount, req.user.id]
        );
        if (!rows.length)
            return res.json({ success: false, error: 'Недостаточно средств' });

        pool.query(
            'INSERT INTO transactions (sender_id, amount, type, description) VALUES ($1,$2,$3,$4)',
            [req.user.id, amount, 'withdrawal', 'Вывод средств']
        ).catch(err => console.error('tx insert:', err.message));

        logActivity(req.user.email, 'withdrawal', 'success', req.ip, `-$${amount}`);
        console.log(`💸 Вывод: ${req.user.username} -$${amount} | баланс: $${rows[0].balance}`);
        res.json({ success: true, balance: rows[0].balance });
    } catch (err) {
        console.error('wallet/withdraw:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

router.post('/transfer', transferLimiter, requireAuth, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    const to     = (req.body.to || '').trim().replace(/^@/, '').toLowerCase();
    const desc   = (req.body.description || '').trim().slice(0, 200);

    if (!to || !amount || amount <= 0)
        return res.status(400).json({ success: false, error: 'Заполните все поля' });
    if (amount > 1_000_000)
        return res.status(400).json({ success: false, error: 'Слишком большая сумма' });
    if (amount < 0.01)
        return res.status(400).json({ success: false, error: 'Минимум $0.01' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const receiverQ = await client.query(
            'SELECT id, username FROM users WHERE (email = $1 OR LOWER(username) = $1) AND banned = false',
            [to]
        );
        if (!receiverQ.rows.length) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        const receiver = receiverQ.rows[0];
        if (receiver.id === req.user.id) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Нельзя отправить себе' });
        }

        const senderW = await client.query(
            'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
            [req.user.id]
        );
        if (parseFloat(senderW.rows[0]?.balance ?? 0) < amount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Недостаточно средств' });
        }

        await client.query(
            'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
            [amount, req.user.id]
        );
        await client.query(
            'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
            [amount, receiver.id]
        );
        const tx = await client.query(
            'INSERT INTO transactions (sender_id, receiver_id, amount, type, description) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [req.user.id, receiver.id, amount, 'transfer', desc || null]
        );

        await client.query('COMMIT');
        await logActivity(req.user.email, 'transfer', 'success', req.ip, `→ ${receiver.username} $${amount}`);
        console.log(`💸 Перевод: ${req.user.username} → ${receiver.username} $${amount}`);
        res.json({ success: true, receiver_username: receiver.username, tx_id: tx.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('wallet/transfer:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

module.exports = router;