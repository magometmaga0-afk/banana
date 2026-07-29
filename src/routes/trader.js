const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const MAX_METHODS = 100;

// Суточный/месячный счётчик использования сбрасывается по календарю —
// без этого daily_used/monthly_used копились бы вечно и реквизит никогда
// не вернулся бы в ротацию после исчерпания лимита
async function resetUsage(userId) {
    await pool.query(
        `UPDATE trader_methods SET
            daily_used        = CASE WHEN daily_reset_at < CURRENT_DATE THEN 0 ELSE daily_used END,
            monthly_used      = CASE WHEN date_trunc('month', monthly_reset_at) < date_trunc('month', CURRENT_DATE) THEN 0 ELSE monthly_used END,
            daily_reset_at    = CURRENT_DATE,
            monthly_reset_at  = CASE WHEN date_trunc('month', monthly_reset_at) < date_trunc('month', CURRENT_DATE) THEN CURRENT_DATE ELSE monthly_reset_at END
         WHERE user_id=$1 AND (daily_reset_at < CURRENT_DATE OR date_trunc('month', monthly_reset_at) < date_trunc('month', CURRENT_DATE))`,
        [userId]
    );
}

async function isVerified(userId) {
    const { rows } = await pool.query('SELECT verified FROM users WHERE id=$1', [userId]);
    return rows[0]?.verified === true;
}

// GET все реквизиты
router.get('/methods', requireAuth, async (req, res) => {
    try {
        await resetUsage(req.user.id);
        const { rows } = await pool.query(
            `SELECT id, type, value, holder, bank, is_active, priority, daily_limit, monthly_limit, daily_used, monthly_used, created_at,
                    (daily_used >= daily_limit OR monthly_used >= monthly_limit) AS over_limit
             FROM trader_methods WHERE user_id=$1 ORDER BY priority ASC, created_at ASC`,
            [req.user.id]
        );
        // Активный реквизит — первый по приоритету среди включённых и не исчерпавших лимит
        const active = rows.find(m => m.is_active && !m.over_limit) || null;
        res.json({ success: true, methods: rows, active_id: active?.id ?? null });
    } catch (err) {
        console.error('trader/methods GET:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// GET активный на данный момент реквизит (с учётом ротации по лимиту)
router.get('/methods/active', requireAuth, async (req, res) => {
    try {
        await resetUsage(req.user.id);
        const { rows } = await pool.query(
            `SELECT id, type, value, holder, bank, priority, daily_limit, monthly_limit, daily_used, monthly_used
             FROM trader_methods
             WHERE user_id=$1 AND is_active=true AND daily_used < daily_limit AND monthly_used < monthly_limit
             ORDER BY priority ASC, created_at ASC LIMIT 1`,
            [req.user.id]
        );
        res.json({ success: true, method: rows[0] || null });
    } catch (err) {
        console.error('trader/methods active:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// POST добавить реквизит
router.post('/methods', requireAuth, async (req, res) => {
    const { type, value, holder, bank, daily_limit, monthly_limit } = req.body;
    const t = type === 'phone' ? 'phone' : 'card';
    const val = (value || '').trim().replace(/\s/g, '');

    if (!val) return res.json({ success: false, error: 'Введите номер' });

    if (t === 'card') {
        if (!/^\d{16}$/.test(val)) return res.json({ success: false, error: 'Номер карты — 16 цифр' });
    } else {
        if (!/^\+?[7-8]\d{10}$/.test(val.replace(/[-\s()]/g, '')))
            return res.json({ success: false, error: 'Введите российский номер телефона' });
    }

    try {
        if (!(await isVerified(req.user.id)))
            return res.json({ success: false, error: 'Пройдите верификацию паспорта, чтобы добавить реквизит' });

        // Лимит и дубликат — одним запросом вместо двух round-trip'ов
        const { rows: [check] } = await pool.query(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE value=$2) AS dup
             FROM trader_methods WHERE user_id=$1`,
            [req.user.id, val]
        );
        if (parseInt(check.total) >= MAX_METHODS)
            return res.json({ success: false, error: `Максимум ${MAX_METHODS} реквизитов` });
        if (parseInt(check.dup) > 0)
            return res.json({ success: false, error: 'Этот реквизит уже добавлен' });

        const { rows } = await pool.query(
            `INSERT INTO trader_methods (user_id, type, value, holder, bank, daily_limit, monthly_limit)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [req.user.id, t, val, (holder||'').trim().toUpperCase()||null, (bank||'').trim()||null,
             parseFloat(daily_limit)||1000000, parseFloat(monthly_limit)||15000000]
        );
        console.log(`💳 Добавлен реквизит: ${req.user.username} | ${t} ${val}`);
        res.json({ success: true, method: rows[0] });
    } catch (err) {
        console.error('trader/methods POST:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// PATCH вкл/выкл реквизит
router.patch('/methods/:id/toggle', requireAuth, async (req, res) => {
    try {
        const { rows: cur } = await pool.query(
            'SELECT is_active FROM trader_methods WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]
        );
        if (!cur.length) return res.status(404).json({ success: false, error: 'Не найден' });

        // Включать можно только верифицированным трейдерам — выключать можно всегда
        if (!cur[0].is_active && !(await isVerified(req.user.id)))
            return res.json({ success: false, error: 'Пройдите верификацию паспорта, чтобы включить реквизит' });

        const { rows } = await pool.query(
            `UPDATE trader_methods SET is_active = NOT is_active
             WHERE id=$1 AND user_id=$2 RETURNING id, is_active, value`,
            [req.params.id, req.user.id]
        );
        console.log(`🔄 Реквизит ${rows[0].is_active ? 'вкл' : 'выкл'}: ${req.user.username} | ${rows[0].value}`);
        res.json({ success: true, is_active: rows[0].is_active });
    } catch (err) {
        console.error('trader/toggle:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// PATCH изменить приоритет
router.patch('/methods/:id/priority', requireAuth, async (req, res) => {
    const priority = parseInt(req.body.priority);
    if (isNaN(priority)) return res.json({ success: false, error: 'Неверный приоритет' });
    try {
        await pool.query(
            'UPDATE trader_methods SET priority=$1 WHERE id=$2 AND user_id=$3',
            [priority, req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('trader/priority:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// PATCH зачесть сумму в счёт лимита реквизита — если лимит исчерпан, ротация
// на следующий активный реквизит происходит сама по себе при следующем /active
router.patch('/methods/:id/use', requireAuth, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.json({ success: false, error: 'Некорректная сумма' });

    try {
        await resetUsage(req.user.id);
        const { rows } = await pool.query(
            `UPDATE trader_methods SET daily_used = daily_used + $1, monthly_used = monthly_used + $1
             WHERE id=$2 AND user_id=$3 AND is_active=true RETURNING *`,
            [amount, req.params.id, req.user.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Не найден или выключен' });

        const method = rows[0];
        const overLimit = parseFloat(method.daily_used) >= parseFloat(method.daily_limit)
                        || parseFloat(method.monthly_used) >= parseFloat(method.monthly_limit);

        let next = null;
        if (overLimit) {
            const { rows: nextRows } = await pool.query(
                `SELECT id, type, value, bank FROM trader_methods
                 WHERE user_id=$1 AND is_active=true AND id!=$2
                       AND daily_used < daily_limit AND monthly_used < monthly_limit
                 ORDER BY priority ASC, created_at ASC LIMIT 1`,
                [req.user.id, method.id]
            );
            next = nextRows[0] || null;
            console.log(`🔁 Лимит исчерпан, смена реквизита: ${req.user.username} | ${method.value} → ${next ? next.value : 'нет доступных'}`);
        }

        res.json({ success: true, method, over_limit: overLimit, next_active: next });
    } catch (err) {
        console.error('trader/use:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// DELETE удалить реквизит
router.delete('/methods/:id', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'DELETE FROM trader_methods WHERE id=$1 AND user_id=$2 RETURNING value',
            [req.params.id, req.user.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Не найден' });
        console.log(`🗑️  Удалён реквизит: ${req.user.username} | ${rows[0].value}`);
        res.json({ success: true });
    } catch (err) {
        console.error('trader/delete:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

module.exports = router;
