const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const http      = require('http');
const https     = require('https');
const { pool, logActivity } = require('../db');
const { sendOtpEmail }      = require('../mailer');
const { requireAuth, invalidateSession, invalidateUserSessions } = require('../middleware/auth');

// ---- helpers ----
function httpFetch(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 5000 }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function parseUA(ua = '') {
    let type = 'desktop', name = 'Компьютер';
    if      (/iPhone/i.test(ua))                        { type = 'mobile';  name = 'iPhone'; }
    else if (/iPad/i.test(ua))                          { type = 'tablet';  name = 'iPad'; }
    else if (/Android/i.test(ua) && /Mobile/i.test(ua)){ type = 'mobile';  name = 'Android'; }
    else if (/Android/i.test(ua))                       { type = 'tablet';  name = 'Android планшет'; }
    else if (/Windows/i.test(ua))                        { name = 'Windows ПК'; }
    else if (/Macintosh/i.test(ua))                      { name = 'Mac'; }
    else if (/Linux/i.test(ua))                          { name = 'Linux'; }

    let browser = '';
    if      (/Edg\//i.test(ua))                          browser = 'Edge';
    else if (/OPR\//i.test(ua))                          browser = 'Opera';
    else if (/Chrome\//i.test(ua))                       browser = 'Chrome';
    else if (/Firefox\//i.test(ua))                      browser = 'Firefox';
    else if (/Safari\//i.test(ua))                       browser = 'Safari';

    return { type, name: browser ? `${name} · ${browser}` : name };
}

function codeToFlag(cc) {
    if (!cc || cc.length !== 2) return '🌍';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => c.charCodeAt(0) + 127397));
}

async function getGeo(ip) {
    const local = ['127.0.0.1','::1','localhost'];
    if (!ip || local.some(l => ip.includes(l)) || ip.startsWith('192.168') || ip.startsWith('10.'))
        return { country: 'Локальная сеть', city: '', flag: '🏠' };
    try {
        const raw  = await httpFetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city&lang=ru`);
        const data = JSON.parse(raw);
        if (data.status === 'success')
            return { country: data.country, city: data.city || '', flag: codeToFlag(data.countryCode) };
    } catch {}
    return { country: null, city: null, flag: '🌍' };
}

const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, error: 'Слишком много запросов. Подождите 15 минут' },
    standardHeaders: true,
    legacyHeaders: false,
});

const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Слишком много попыток. Подождите 15 минут' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Слишком много попыток. Подождите 15 минут' },
    standardHeaders: true,
    legacyHeaders: false,
});

const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Слишком много попыток. Подождите 15 минут' },
    standardHeaders: true,
    legacyHeaders: false,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(res, rules) {
    for (const [condition, message] of rules) {
        if (condition) return res.status(400).json({ success: false, error: message });
    }
}

const codes = {};
// Тикеты подтверждённого email: выдаются только после успешного verify-otp
// и требуются в register/reset-password — иначе эти эндпоинты можно вызвать
// напрямую по одному email, без реального владения почтой
const verifiedTickets = {};

function issueTicket(email) {
    const ticket = crypto.randomBytes(32).toString('hex');
    verifiedTickets[email] = { ticket, expires: Date.now() + 10 * 60 * 1000 };
    return ticket;
}

function consumeTicket(email, ticket) {
    const rec = verifiedTickets[email];
    if (!rec || rec.ticket !== ticket || Date.now() > rec.expires) return false;
    delete verifiedTickets[email];
    return true;
}

router.post('/send-otp', otpLimiter, (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    if (validate(res, [
        [!email,              'Email не указан'],
        [!EMAIL_RE.test(email), 'Некорректный email'],
    ])) return;

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    codes[email] = { code, expires: Date.now() + 600_000 };

    if (process.env.NODE_ENV !== 'production') console.log(`📧 OTP для ${email}: ${code}`);

    sendOtpEmail(email, code)
        .then(() => res.json({ success: true }))
        .catch(err => {
            console.error('Mailer:', err.message);
            res.status(500).json({ success: false, error: 'Ошибка отправки письма' });
        });
});

router.post('/verify-otp', verifyLimiter, (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const code  = (req.body.code  || '').trim();

    const record = codes[email];
    if (!record)                    return res.json({ success: false, error: 'Код не найден' });
    if (Date.now() > record.expires) { delete codes[email]; return res.json({ success: false, error: 'Код истёк' }); }
    if (record.code !== code)        return res.json({ success: false, error: 'Неверный код' });

    delete codes[email];
    const ticket = issueTicket(email);
    res.json({ success: true, ticket });
});

router.post('/register', async (req, res) => {
    const username = (req.body.username || '').trim();
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password =  req.body.password || '';
    const ticket   =  req.body.ticket   || '';

    if (validate(res, [
        [!username || !email || !password,  'Все поля обязательны'],
        [username.length < 3,               'Имя минимум 3 символа'],
        [username.length > 50,              'Имя слишком длинное'],
        [!/^[a-zA-Zа-яА-ЯёЁ0-9_.\-]+$/.test(username), 'Только буквы, цифры, _ . -'],
        [!EMAIL_RE.test(email),             'Некорректный email'],
        [password.length < 8,               'Пароль минимум 8 символов'],
        [password.length > 128,             'Пароль слишком длинный'],
    ])) return;

    if (!consumeTicket(email, ticket))
        return res.status(400).json({ success: false, error: 'Email не подтверждён. Запросите код заново' });

    try {
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length) return res.status(409).json({ success: false, error: 'Email уже зарегистрирован' });

        const hash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id',
            [username, email, hash]
        );
        await pool.query('INSERT INTO wallets (user_id) VALUES ($1)', [rows[0].id]);

        await logActivity(email, 'register', 'success', req.ip);
        console.log(`✅ Регистрация: ${username} (${email}) #${rows[0].id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('register:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

router.post('/login', loginLimiter, async (req, res) => {
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password =  req.body.password || '';

    if (validate(res, [
        [!email || !password,    'Введите email и пароль'],
        [!EMAIL_RE.test(email),  'Некорректный email'],
    ])) return;

    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (!rows.length) {
            await logActivity(email, 'login', 'failed', req.ip, 'not found');
            console.log(`⛔ Вход не найден: ${email} | IP: ${req.ip}`);
            return res.json({ success: false, error: 'Пользователь не найден' });
        }

        if (rows[0].banned) {
            await logActivity(email, 'login', 'failed', req.ip, 'account banned');
            console.log(`🚫 Вход заблокирован: ${rows[0].username} | IP: ${req.ip}`);
            return res.json({ success: false, error: 'Аккаунт заблокирован' });
        }

        const valid = await bcrypt.compare(password, rows[0].password_hash);
        if (!valid) {
            await logActivity(email, 'login', 'failed', req.ip, 'wrong password');
            console.log(`❌ Неверный пароль: ${rows[0].username} | IP: ${req.ip}`);
            return res.json({ success: false, error: 'Неверный пароль' });
        }

        await logActivity(email, 'login', 'success', req.ip);
        console.log(`✅ Вход: ${rows[0].username} (${email}) | IP: ${req.ip}`);

        const jti   = crypto.randomBytes(16).toString('hex');
        const token = jwt.sign(
            { id: rows[0].id, username: rows[0].username, email, role: rows[0].role || 'trader', jti },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Сохраняем сессию перед ответом — иначе первый запрос дашборда получит 401
        const ua = req.headers['user-agent'] || '';
        const { type: deviceType, name: deviceName } = parseUA(ua);
        const ip = req.ip || '';

        // То же устройство (тот же IP + тип/имя) уже заходило — обновляем его
        // сессию, а не плодим новую строку на каждый вход
        const { rows: existing } = await pool.query(
            `SELECT id, jti FROM sessions
             WHERE user_id=$1 AND ip=$2 AND device_type=$3 AND device_name=$4 AND is_active=true`,
            [rows[0].id, ip, deviceType, deviceName]
        );
        if (existing.length) {
            await pool.query(`UPDATE sessions SET jti=$1, last_seen=NOW() WHERE id=$2`, [jti, existing[0].id]);
            invalidateSession(existing[0].jti);
        } else {
            await pool.query(
                `INSERT INTO sessions (user_id,jti,ip,device_type,device_name) VALUES ($1,$2,$3,$4,$5)`,
                [rows[0].id, jti, ip, deviceType, deviceName]
            );
        }

        // Гео — fire-and-forget, не задерживаем ответ
        getGeo(ip).then(geo => {
            if (geo.country) {
                pool.query(
                    `UPDATE sessions SET country=$1,city=$2,flag=$3 WHERE jti=$4`,
                    [geo.country, geo.city, geo.flag, jti]
                ).catch(() => {});
                console.log(`   📍 ${rows[0].username} из ${geo.flag} ${geo.city || geo.country} | ${deviceName}`);
            }
        }).catch(() => {});

        res.json({ success: true, token, username: rows[0].username });
    } catch (err) {
        console.error('login:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

router.post('/reset-password', resetLimiter, async (req, res) => {
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password =  req.body.password || '';
    const ticket   =  req.body.ticket   || '';

    if (validate(res, [
        [!email || !password,  'Нет данных'],
        [password.length < 8,  'Пароль минимум 8 символов'],
        [password.length > 128,'Пароль слишком длинный'],
    ])) return;

    // Без подтверждённого кода сброс запрещён — иначе смену пароля
    // можно вызвать одним запросом, зная только чужой email
    if (!consumeTicket(email, ticket))
        return res.status(400).json({ success: false, error: 'Email не подтверждён. Запросите код заново' });

    try {
        const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (!rows.length) return res.json({ success: false, error: 'Пользователь не найден' });

        const hash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email]);
        await logActivity(email, 'password_reset', 'success', req.ip);
        console.log(`🔑 Смена пароля: ${email}`);
        res.json({ success: true });
    } catch (err) {
        console.error('reset-password:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// GET активных сессий
router.get('/sessions', requireAuth, async (req, res) => {
    try {
        let { rows } = await pool.query(
            `SELECT id, jti, ip, device_type, device_name, country, city, flag, created_at, last_seen
             FROM sessions WHERE user_id=$1 AND is_active=true ORDER BY last_seen DESC`,
            [req.user.id]
        );

        // Если сессий нет (старый JWT без jti) — создаём запись для текущего запроса
        if (rows.length === 0) {
            const ua = req.headers['user-agent'] || '';
            const { type: deviceType, name: deviceName } = parseUA(ua);
            const jti = req.user.jti || crypto.randomBytes(16).toString('hex');
            const ip  = req.ip || '';
            try {
                await pool.query(
                    `INSERT INTO sessions (user_id,jti,ip,device_type,device_name)
                     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (jti) DO UPDATE SET last_seen=NOW()`,
                    [req.user.id, jti, ip, deviceType, deviceName]
                );
                getGeo(ip).then(geo => {
                    if (geo.country) pool.query(
                        `UPDATE sessions SET country=$1,city=$2,flag=$3 WHERE jti=$4`,
                        [geo.country, geo.city, geo.flag, jti]
                    ).catch(() => {});
                }).catch(() => {});
                const refetch = await pool.query(
                    `SELECT id, jti, ip, device_type, device_name, country, city, flag, created_at, last_seen
                     FROM sessions WHERE user_id=$1 AND is_active=true ORDER BY last_seen DESC`,
                    [req.user.id]
                );
                rows = refetch.rows;
            } catch (e) { console.error('sessions auto-create:', e.message); }
        }

        // Обновляем last_seen текущей сессии
        if (req.user.jti) {
            pool.query(`UPDATE sessions SET last_seen=NOW() WHERE jti=$1`, [req.user.jti]).catch(() => {});
        }
        const curJti = req.user.jti || (rows[0] && rows[0].jti);
        res.json({ sessions: rows.map(s => ({ ...s, is_current: s.jti === curJti })) });
    } catch (err) {
        console.error('sessions GET:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// DELETE — завершить все сессии кроме текущей
router.delete('/sessions', requireAuth, async (req, res) => {
    try {
        await pool.query(
            `UPDATE sessions SET is_active=false WHERE user_id=$1 AND jti!=$2`,
            [req.user.id, req.user.jti || '']
        );
        invalidateUserSessions();
        console.log(`🚪 Завершил все сессии: ${req.user.username}`);
        res.json({ success: true });
    } catch (err) {
        console.error('sessions DELETE all:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// DELETE — завершить конкретную сессию
router.delete('/sessions/:id', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT jti,device_name FROM sessions WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Сессия не найдена' });
        if (rows[0].jti === req.user.jti) return res.status(400).json({ error: 'Нельзя завершить текущую сессию' });
        await pool.query(`UPDATE sessions SET is_active=false WHERE id=$1`, [req.params.id]);
        invalidateSession(rows[0].jti);
        console.log(`🚪 Завершил сессию: ${req.user.username} | ${rows[0].device_name}`);
        res.json({ success: true });
    } catch (err) {
        console.error('sessions DELETE:', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/change-password', requireAuth, async (req, res) => {
    const currentPassword = req.body.currentPassword || '';
    const newPassword     = req.body.newPassword     || '';

    if (validate(res, [
        [!currentPassword || !newPassword, 'Заполните все поля'],
        [newPassword.length < 8,           'Новый пароль минимум 8 символов'],
        [newPassword.length > 128,         'Пароль слишком длинный'],
    ])) return;

    try {
        const { rows } = await pool.query('SELECT password_hash, email FROM users WHERE id = $1', [req.user.id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!valid) return res.status(400).json({ success: false, error: 'Неверный текущий пароль' });

        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
        await logActivity(rows[0].email, 'change_password', 'success', req.ip);
        console.log(`🔑 Смена пароля: ${req.user.username} | IP: ${req.ip}`);
        res.json({ success: true });
    } catch (err) {
        console.error('change-password:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// POST /api/auth/change-username
router.post('/change-username', requireAuth, async (req, res) => {
    const newUsername = (req.body.username || '').trim();
    const password    =  req.body.password  || '';

    if (!newUsername)           return res.json({ success: false, error: 'Введите новый логин' });
    if (newUsername.length < 3) return res.json({ success: false, error: 'Минимум 3 символа' });
    if (newUsername.length > 50)return res.json({ success: false, error: 'Максимум 50 символов' });
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_.\-]+$/.test(newUsername))
        return res.json({ success: false, error: 'Только буквы, цифры, _ . -' });

    try {
        const { rows } = await pool.query('SELECT password_hash, email FROM users WHERE id=$1', [req.user.id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        const ok = await bcrypt.compare(password, rows[0].password_hash);
        if (!ok) return res.json({ success: false, error: 'Неверный пароль' });

        const dup = await pool.query('SELECT id FROM users WHERE username=$1 AND id!=$2', [newUsername, req.user.id]);
        if (dup.rows.length) return res.json({ success: false, error: 'Логин уже занят' });

        await pool.query('UPDATE users SET username=$1 WHERE id=$2', [newUsername, req.user.id]);
        await logActivity(rows[0].email, 'change_username', 'success', req.ip, newUsername);
        console.log(`✏️  Смена логина: ${req.user.username} → ${newUsername}`);
        res.json({ success: true });
    } catch (err) {
        console.error('change-username:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// GET /api/auth/passport — статус верификации трейдера
router.get('/passport', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT passport_full_name, passport_number, passport_submitted_at, verified
             FROM users WHERE id=$1`,
            [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        const u = rows[0];
        res.json({
            success: true,
            full_name:     u.passport_full_name,
            number:        u.passport_number,
            submitted_at:  u.passport_submitted_at,
            verified:      u.verified,
            status: !u.passport_submitted_at ? 'none' : u.verified ? 'verified' : 'pending',
        });
    } catch (err) {
        console.error('auth/passport GET:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// POST /api/auth/passport — подать паспортные данные на верификацию
router.post('/passport', requireAuth, async (req, res) => {
    const fullName = (req.body.full_name || '').trim().replace(/\s+/g, ' ');
    const number   = (req.body.number    || '').replace(/\D/g, '');

    if (validate(res, [
        [fullName.length < 5 || fullName.length > 150, 'Введите ФИО как в паспорте'],
        [!/^[a-zA-Zа-яА-ЯёЁ\-\s]+$/.test(fullName),     'ФИО может содержать только буквы'],
        [number.length !== 10,                           'Серия и номер паспорта — 10 цифр'],
    ])) return;

    try {
        // Повторная подача сбрасывает верификацию — админ должен проверить заново
        await pool.query(
            `UPDATE users SET passport_full_name=$1, passport_number=$2,
                              passport_submitted_at=NOW(), verified=false
             WHERE id=$3`,
            [fullName.toUpperCase(), number, req.user.id]
        );
        await logActivity(req.user.email, 'passport_submit', 'success', req.ip);
        console.log(`🛂 Паспорт подан на проверку: ${req.user.username}`);
        res.json({ success: true, status: 'pending' });
    } catch (err) {
        console.error('auth/passport POST:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// POST /api/auth/send-email-code — отправить код на текущую почту
router.post('/send-email-code', requireAuth, async (req, res) => {
    const newEmail = (req.body.email || '').trim().toLowerCase();
    const password =  req.body.password || '';

    if (!newEmail)                return res.json({ success: false, error: 'Введите новый email' });
    if (!EMAIL_RE.test(newEmail)) return res.json({ success: false, error: 'Некорректный email' });

    try {
        const { rows } = await pool.query('SELECT password_hash, email FROM users WHERE id=$1', [req.user.id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        const ok = await bcrypt.compare(password, rows[0].password_hash);
        if (!ok) return res.json({ success: false, error: 'Неверный пароль' });

        if (rows[0].email === newEmail) return res.json({ success: false, error: 'Это уже ваш email' });

        const dup = await pool.query('SELECT id FROM users WHERE email=$1 AND id!=$2', [newEmail, req.user.id]);
        if (dup.rows.length) return res.json({ success: false, error: 'Email уже используется' });

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expires = new Date(Date.now() + 2 * 60 * 1000); // 2 минуты

        await pool.query(
            `INSERT INTO email_change_otps (user_id, new_email, code, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET new_email=$2, code=$3, expires_at=$4`,
            [req.user.id, newEmail, code, expires]
        );

        await sendOtpEmail(rows[0].email, code);
        res.json({ success: true });
    } catch (err) {
        console.error('send-email-code:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка отправки письма' });
    }
});

// POST /api/auth/change-email — подтвердить код и сменить email
router.post('/change-email', requireAuth, async (req, res) => {
    const code = (req.body.code || '').trim();
    if (!code) return res.json({ success: false, error: 'Введите код из письма' });

    try {
        const { rows } = await pool.query(
            `SELECT o.new_email, o.code, o.expires_at, u.email AS old_email
             FROM email_change_otps o JOIN users u ON u.id=o.user_id
             WHERE o.user_id=$1`,
            [req.user.id]
        );
        if (!rows.length) return res.json({ success: false, error: 'Сначала запросите код' });

        if (new Date() > new Date(rows[0].expires_at))
            return res.json({ success: false, error: 'Код истёк. Запросите новый' });

        if (rows[0].code !== code)
            return res.json({ success: false, error: 'Неверный код' });

        await pool.query('UPDATE users SET email=$1 WHERE id=$2', [rows[0].new_email, req.user.id]);
        await pool.query('DELETE FROM email_change_otps WHERE user_id=$1', [req.user.id]);
        await logActivity(rows[0].new_email, 'change_email', 'success', req.ip, `from: ${rows[0].old_email}`);
        console.log(`📧 Смена email: ${req.user.username} | ${rows[0].old_email} → ${rows[0].new_email}`);
        res.json({ success: true });
    } catch (err) {
        console.error('change-email:', err.message);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

module.exports = router;
