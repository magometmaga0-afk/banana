require('dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const https       = require('https');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { initDB }  = require('./src/db');

// ===== КУРСЫ ВАЛЮТ СНГ =====
const CIS_CODES = ['RUB','UAH','BYN','KZT','AZN','AMD','GEL','MDL','KGS','TJS','TMT','UZS'];
let _rateCache = { rates: null, previous: null, ts: 0 };

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 8000 }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function fetchAllRates() {
    let rates = {}, previous = {};

    // Источник 1: cbr-xml-daily.ru — RUB с предыдущим курсом
    try {
        const raw = await httpGet('https://www.cbr-xml-daily.ru/daily_json.js');
        const json = JSON.parse(raw);
        const usd  = json?.Valute?.USD;
        if (usd?.Value) { rates.RUB = usd.Value; previous.RUB = usd.Previous || usd.Value; }
    } catch(e) { console.warn('[rate] cbr-xml-daily:', e.message); }

    // Источник 2: open.er-api.com — все валюты СНГ
    try {
        const raw  = await httpGet('https://open.er-api.com/v6/latest/USD');
        const json = JSON.parse(raw);
        if (json?.rates) {
            CIS_CODES.forEach(c => {
                if (json.rates[c] && !(c === 'RUB' && rates.RUB)) rates[c] = json.rates[c];
            });
        }
    } catch(e) { console.warn('[rate] open.er-api:', e.message); }

    // Источник 3: CBR XML — запасной для RUB
    if (!rates.RUB) {
        try {
            const xml   = await httpGet('https://www.cbr.ru/scripts/XML_daily.asp');
            const match = xml.match(/CharCode>USD[\s\S]*?<Value>([\d,]+)<\/Value>/);
            if (match) { const r = parseFloat(match[1].replace(',','.')); if (r>0) { rates.RUB=r; previous.RUB=r; } }
        } catch(e) { console.warn('[rate] cbr.ru XML:', e.message); }
    }

    if (!Object.keys(rates).length) throw new Error('all rate sources failed');
    return { rates, previous };
}

// Кэш обфусцированных файлов — строится при старте воркера, не на первый запрос
const _jsCache = {};
function buildObfuscatedJS(filePath) {
    if (_jsCache[filePath]) return _jsCache[filePath];
    try {
        const src = fs.readFileSync(filePath, 'utf8');
        const out = JavaScriptObfuscator.obfuscate(src, {
            compact: true,
            controlFlowFlattening: false,   // отключено: +3-5с к старту, нет прироста защиты
            deadCodeInjection: false,        // отключено: раздувало файл, тормозило парсинг
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.8,
            identifierNamesGenerator: 'hexadecimal',
            rotateStringArray: true,
            selfDefending: true,
            unicodeEscapeSequence: false,
        });
        _jsCache[filePath] = out.getObfuscatedCode();
        return _jsCache[filePath];
    } catch (e) {
        console.error('Obfuscate error:', e.message);
        return fs.readFileSync(filePath, 'utf8');
    }
}

// Прогрев кэша обфускации при старте воркера (не блокирует — setImmediate)
function warmupJsCache() {
    setImmediate(() => {
        const jsDir = path.join(__dirname, 'public', 'js');
        try {
            fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).forEach(f => {
                buildObfuscatedJS(path.join(jsDir, f));
            });
        } catch (e) { console.error('JS warmup:', e.message); }
    });
}

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL не задан в .env');
    process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// Gzip всех ответов
app.use(compression({ level: 6, threshold: 1024 }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));

// Обход ngrok-предупреждения для всех ответов
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', '1');
    next();
});

// Обфускация JS на лету — кэш живёт до перезапуска сервера
// Версия в URL (?v=14) обеспечивает cache busting у клиента
app.get('/js/:file.js', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'js', req.params.file + '.js');
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type',  'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buildObfuscatedJS(filePath));
});

const WEEK = 604800;
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        if (/\.html$/.test(filePath)) {
            // HTML не кэшируем — всегда свежий
            res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.(css|woff2?|ttf|eot|svg|png|jpg|jpeg|ico|webp)$/.test(filePath)) {
            // CSS/шрифты/картинки — версии в URL, кэш на неделю
            res.setHeader('Cache-Control', `public, max-age=${WEEK}, immutable`);
        } else {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

app.get('/api/rate', async (req, res) => {
    try {
        const now = Date.now();
        if (_rateCache.rates && now - _rateCache.ts < 5 * 60 * 1000) {
            return res.json({ rates: _rateCache.rates, previous: _rateCache.previous });
        }
        const { rates, previous } = await fetchAllRates();
        _rateCache = { rates, previous, ts: now };
        res.json({ rates, previous });
    } catch (e) {
        if (_rateCache.rates) return res.json({ rates: _rateCache.rates, previous: _rateCache.previous });
        res.status(503).json({ error: 'Курс временно недоступен' });
    }
});

app.use('/api/auth',   require('./src/routes/auth'));
app.use('/api/admin',  require('./src/routes/admin'));
app.use('/api/wallet', require('./src/routes/wallet'));
app.use('/api/trader', require('./src/routes/trader'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

initDB().then(() => {
    const server = app.listen(PORT, () => {
        console.log(`🚀 Сервер:    http://localhost:${PORT}`);
        console.log(`📊 Админ:     http://localhost:${PORT}/admin.html`);
        console.log(`💳 Кабинет:   http://localhost:${PORT}/dashboard.html`);
        console.log('📧 Почта готова!');
        warmupJsCache();
    });

    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT',  shutdown);
}).catch(err => {
    console.error('❌ БД:', err.message);
    process.exit(1);
});
