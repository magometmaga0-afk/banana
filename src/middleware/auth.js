const jwt  = require('jsonwebtoken');
const { pool } = require('../db');

// In-memory кэш активных сессий: jti → { valid: bool, ts: number }
// Снижает DB нагрузку: проверка раз в 15 сек вместо каждого запроса
const _sessCache = new Map();
const SESS_TTL = 15_000;
const CACHE_MAX_AGE = 60 * 60 * 1000;

// Без этого Map растёт бесконечно — записи по старым/неактивным jti
// никогда не удаляются сами по себе (только явный terminate чистит конкретный ключ)
setInterval(() => {
    const now = Date.now();
    for (const [jti, entry] of _sessCache) {
        if (now - entry.ts > CACHE_MAX_AGE) _sessCache.delete(jti);
    }
}, CACHE_MAX_AGE).unref();

async function checkSession(jti) {
    const cached = _sessCache.get(jti);
    if (cached && Date.now() - cached.ts < SESS_TTL) return cached.valid;
    try {
        const { rows } = await pool.query(
            'SELECT 1 FROM sessions WHERE jti=$1 AND is_active=true LIMIT 1', [jti]
        );
        const valid = rows.length > 0;
        _sessCache.set(jti, { valid, ts: Date.now() });
        return valid;
    } catch {
        return false; // fail-closed при недоступной БД — для финансовых операций безопаснее отказать, чем пропустить
    }
}

// Сбросить кэш для конкретной сессии (вызывается при terminate)
function invalidateSession(jti) { _sessCache.delete(jti); }
// Сбросить все сессии пользователя (при terminate all)
function invalidateUserSessions() { _sessCache.clear(); }

async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Необходима авторизация' });
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        if (user.jti) {
            const valid = await checkSession(user.jti);
            if (!valid) return res.status(401).json({ error: 'Сессия завершена. Войдите снова' });
        }
        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: 'Сессия истекла. Войдите снова' });
    }
}

function requireAdmin(req, res, next) {
    // Только заголовок — ключ в query-string оседает в логах сервера/прокси
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    next();
}

module.exports = { requireAuth, requireAdmin, invalidateSession, invalidateUserSessions };