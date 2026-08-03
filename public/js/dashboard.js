const token = localStorage.getItem('bt_token');
if (!token) window.location.replace('/');

const CACHE_KEY = 'bt_init_v2';

const AVATAR_COLORS = [
    'linear-gradient(135deg,#7c3aed,#5b21b6)',
    'linear-gradient(135deg,#0ea5e9,#0369a1)',
    'linear-gradient(135deg,#10b981,#059669)',
    'linear-gradient(135deg,#f59e0b,#d97706)',
    'linear-gradient(135deg,#ef4444,#b91c1c)',
    'linear-gradient(135deg,#ec4899,#be185d)',
    'linear-gradient(135deg,#06b6d4,#0284c7)',
];

function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// Экранирование перед вставкой в innerHTML — username/email/описание перевода
// пишут сами пользователи
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function setAllAvatars(color, letter) {
    ['pf-avatar','sb-avatar','header-avatar'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.background = color; if (letter) el.textContent = letter; }
    });
}

function makeAvatar(name, size = 52) {
    const el = document.createElement('div');
    el.style.cssText = `width:${size}px;height:${size}px;border-radius:${Math.round(size*.27)}px;background:${avatarColor(name)};display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*.38)}px;font-weight:900;color:#fff;flex-shrink:0`;
    el.textContent = name[0].toUpperCase();
    return el;
}

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'ngrok-skip-browser-warning': '1',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) { logout(); return {}; }
    return res.json();
}

function fmt(amount) {
    return parseFloat(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(iso) {
    const diff = Date.now() - new Date(iso);
    if (diff < 60_000)      return 'только что';
    if (diff < 3_600_000)   return Math.floor(diff / 60_000) + ' мин. назад';
    if (diff < 86_400_000)  return Math.floor(diff / 3_600_000) + ' ч. назад';
    if (diff < 172_800_000) return 'вчера';
    return new Date(iso).toLocaleDateString('ru-RU');
}

function withBtn(btn, fn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;
    fn().finally(() => { btn.disabled = false; btn.innerHTML = orig; });
}

// ===== COUNTER ANIMATION =====
function animateValue(el, from, to, duration = 900) {
    const startTime = performance.now();
    const update = now => {
        const p = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 4);
        const val = from + (to - from) * eased;
        el.textContent = fmt(val).split('.')[0];
        if (p < 1) requestAnimationFrame(update);
        else el.textContent = fmt(to).split('.')[0];
    };
    requestAnimationFrame(update);
}

// ===== STATE =====
let currentBalance = 0;
let currentUser    = {};
let allTx          = [];
let activeFilter   = '';
let balanceAnimated = false;
let usdRubRate     = 0;
let allRates       = {};
let selectedCur    = localStorage.getItem('bt_currency') || 'RUB';

const CIS_CURRENCIES = [
    { code:'RUB', name:'Российский рубль',      flag:'🇷🇺' },
    { code:'UAH', name:'Украинская гривна',     flag:'🇺🇦' },
    { code:'BYN', name:'Белорусский рубль',     flag:'🇧🇾' },
    { code:'KZT', name:'Казахстанский тенге',   flag:'🇰🇿' },
    { code:'AZN', name:'Азербайджанский манат', flag:'🇦🇿' },
    { code:'AMD', name:'Армянский драм',        flag:'🇦🇲' },
    { code:'GEL', name:'Грузинский лари',       flag:'🇬🇪' },
    { code:'MDL', name:'Молдавский лей',        flag:'🇲🇩' },
    { code:'KGS', name:'Киргизский сом',        flag:'🇰🇬' },
    { code:'TJS', name:'Таджикский сомони',     flag:'🇹🇯' },
    { code:'TMT', name:'Туркменский манат',     flag:'🇹🇲' },
    { code:'UZS', name:'Узбекский сум',         flag:'🇺🇿' },
];

function setBalance(newVal) {
    const prev = currentBalance;
    currentBalance = parseFloat(newVal) || 0;
    const intEl  = document.getElementById('balance-int');
    const fracEl = document.getElementById('balance-frac');
    const [int, frac] = fmt(currentBalance).split('.');
    if (!balanceAnimated) {
        animateValue(intEl, 0, currentBalance);
        balanceAnimated = true;
    } else {
        animateValue(intEl, prev, currentBalance);
    }
    fracEl.textContent = '.' + frac;
    document.getElementById('withdraw-avail').textContent = '$' + fmt(currentBalance);
    const ta = document.getElementById('transfer-avail');
    if (ta) ta.textContent = '$' + fmt(currentBalance);
    updateRubDisplay();
}

function updateRubDisplay() {
    const rate = allRates[selectedCur] || usdRubRate;
    if (!rate) return;
    const rubEl  = document.getElementById('balance-rub');
    const labEl  = document.getElementById('balance-cur-label');
    const codeEl = document.getElementById('rate-cur-code');
    if (rubEl)  rubEl.textContent  = fmt(currentBalance * rate);
    if (labEl)  labEl.textContent  = selectedCur;
    if (codeEl) codeEl.textContent = selectedCur;
}

// ===== EXCHANGE RATE =====
async function fetchRate() {
    try {
        const res  = await fetch('/api/rate');
        if (!res.ok) throw new Error();
        const data = await res.json();

        if (data.rates) {
            allRates   = data.rates;
            usdRubRate = data.rates.RUB || 0;
        } else if (data.rate) {
            allRates   = { RUB: data.rate };
            usdRubRate = data.rate;
        }

        const rate   = allRates[selectedCur] || usdRubRate;
        const rateEl = document.getElementById('usd-rate-val');
        if (rateEl) rateEl.textContent = rate ? rate.toFixed(2) : '—';

        const prev     = data.previous && data.previous[selectedCur];
        const changeEl = document.getElementById('usd-rate-change');
        if (changeEl) {
            if (prev && rate) {
                const pct = (rate - prev) / prev * 100;
                changeEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                changeEl.className   = 'home-rate-change ' + (pct >= 0 ? 'pos' : 'neg');
            } else {
                changeEl.textContent = '';
            }
        }

        updateRubDisplay();
    } catch {
        const rateEl = document.getElementById('usd-rate-val');
        if (rateEl && !usdRubRate) rateEl.textContent = 'Нет данных';
    }
}

// ===== CURRENCY PICKER =====
function toggleCurrencyPicker(e) {
    e.stopPropagation();
    const widget = document.getElementById('rate-widget');
    const picker = document.getElementById('currency-picker');
    if (!picker) return;

    if (picker.classList.contains('open')) {
        picker.classList.remove('open');
        widget.classList.remove('picker-open');
        return;
    }

    picker.innerHTML = '<div class="cp-header">Выберите валюту СНГ</div>' +
        CIS_CURRENCIES.map(c => {
            const val = allRates[c.code];
            return `<div class="cp-item${c.code === selectedCur ? ' active' : ''}" onclick="selectCurrency('${c.code}',event)">
                <span class="cp-flag">${c.flag}</span>
                <div class="cp-info"><span class="cp-code">${c.code}</span><span class="cp-name">${c.name}</span></div>
                <span class="cp-val">${val ? val.toFixed(2) : '—'}</span>
            </div>`;
        }).join('');

    picker.classList.add('open');
    widget.classList.add('picker-open');
}

function selectCurrency(code, e) {
    if (e) e.stopPropagation();
    selectedCur = code;
    localStorage.setItem('bt_currency', code);

    const widget = document.getElementById('rate-widget');
    const picker = document.getElementById('currency-picker');
    if (picker) picker.classList.remove('open');
    if (widget) widget.classList.remove('picker-open');

    const rate    = allRates[code];
    const rateEl  = document.getElementById('usd-rate-val');
    const codeEl  = document.getElementById('rate-cur-code');
    if (rateEl)  rateEl.textContent  = rate ? rate.toFixed(2) : '—';
    if (codeEl)  codeEl.textContent  = code;

    const changeEl = document.getElementById('usd-rate-change');
    if (changeEl && code !== 'RUB') changeEl.textContent = '';

    updateRubDisplay();
}

document.addEventListener('click', () => {
    const widget = document.getElementById('rate-widget');
    const picker = document.getElementById('currency-picker');
    if (picker) picker.classList.remove('open');
    if (widget) widget.classList.remove('picker-open');
});

fetchRate();
setInterval(fetchRate, 5 * 60 * 1000);

// Тихое обновление баланса и транзакций каждые 30 секунд
async function silentRefresh() {
    try {
        const data = await api('GET', '/api/wallet/init');
        if (!data || !data.username) return;
        const prev = currentUser.balance;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, _ts: Date.now() })); } catch {}
        applyData(data);
        // Мигнуть балансом если изменился
        if (prev !== undefined && parseFloat(data.balance) !== parseFloat(prev)) {
            const el = document.getElementById('balance-int');
            if (el) {
                el.parentElement.style.transition = 'opacity .3s';
                el.parentElement.style.opacity = '0.4';
                setTimeout(() => { el.parentElement.style.opacity = '1'; }, 400);
            }
        }
    } catch {}
}
setInterval(silentRefresh, 30_000);

// ===== WALLET CARD SCROLL DOTS =====
(function() {
    const wcEl = document.querySelector('.wallet-cards');
    const dots = document.querySelectorAll('.wc-dot');
    if (!wcEl || !dots.length) return;
    wcEl.addEventListener('scroll', () => {
        const card = wcEl.querySelector('.wallet-card');
        if (!card) return;
        const gap = 12;
        const cardW = card.offsetWidth + gap;
        const idx = Math.min(dots.length - 1, Math.round(wcEl.scrollLeft / cardW));
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    }, { passive: true });
})();

// ===== APPLY DATA (кэш или сервер) =====
function applyData(data) {
    if (!data || !data.username) return;
    currentUser = data;

    const color = avatarColor(data.username);
    const letter = data.username[0].toUpperCase();
    const av = document.getElementById('header-avatar');
    if (av) { av.textContent = letter; av.style.background = color; }

    const sbAv = document.getElementById('sb-avatar');
    if (sbAv) { sbAv.textContent = letter; sbAv.style.background = color; }

    const sbUn = document.getElementById('sb-username');
    if (sbUn) sbUn.textContent = data.username;

    setBalance(data.balance);

    const s = data.stats || {};
    document.getElementById('stat-received').textContent = '$' + fmt(s.total_received);
    document.getElementById('stat-sent').textContent     = '$' + fmt(s.total_sent);
    document.getElementById('stat-count').textContent    = s.tx_count || 0;

    const profitEl = document.getElementById('stat-profit');
    if (profitEl) {
        const profit = parseFloat(s.total_received || 0) - parseFloat(s.total_sent || 0);
        profitEl.textContent = (profit >= 0 ? '+' : '-') + '$' + fmt(Math.abs(profit));
    }

    if (Array.isArray(data.transactions)) {
        allTx = data.transactions;
        applyFilter();
    }

    // Роль
    const roleMap = { trader: '🤝 Трейдер', casino: '🎰 Казино', admin: '⚙️ Администратор' };
    const roleEl = document.getElementById('acc-role-display');
    if (roleEl) {
        const roleKey = data.role || 'trader';
        roleEl.textContent = roleMap[roleKey] || roleKey;
        roleEl.dataset.role = roleKey;
    }

    // Показать/скрыть раздел трейдера в сайдбаре
    showTraderNav(data.role);
}

// ===== PROGRESS BAR =====
let _progressBar = null;
function showProgress() {
    if (!_progressBar) {
        _progressBar = document.createElement('div');
        _progressBar.style.cssText = 'position:fixed;top:0;left:0;height:3px;z-index:9999;background:linear-gradient(90deg,#FFD700,#FFA500);border-radius:0 2px 2px 0;transition:width .35s ease,opacity .3s ease;width:0;opacity:1;pointer-events:none';
        document.body.appendChild(_progressBar);
    }
    _progressBar.style.opacity = '1';
    _progressBar.style.background = 'linear-gradient(90deg,#FFD700,#FFA500)';
    _progressBar.style.width = '0';
    requestAnimationFrame(() => { _progressBar.style.width = '70%'; });
    document.querySelectorAll('.wallet-card, #hero-card').forEach(c => c.classList.add('refreshing'));
}
function finishProgress(ok) {
    if (!_progressBar) return;
    _progressBar.style.background = ok
        ? 'linear-gradient(90deg,#00d26a,#00a854)'
        : 'linear-gradient(90deg,#ff4757,#c0392b)';
    _progressBar.style.width = '100%';
    setTimeout(() => { if (_progressBar) _progressBar.style.opacity = '0'; }, 400);
    document.querySelectorAll('.wallet-card, #hero-card').forEach(c => c.classList.remove('refreshing'));
}

// ===== ЕДИНЫЙ ЗАПРОС =====
async function loadInit() {
    showProgress();
    try {
        const data = await api('GET', '/api/wallet/init');
        if (!data || !data.username) { finishProgress(false); return; }
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, _ts: Date.now() })); } catch {}
        balanceAnimated = false;
        applyData(data);
        finishProgress(true);
    } catch {
        finishProgress(false);
    }
}

// ===== TRANSACTIONS =====
const TX_ICONS = {
    deposit:    { cls:'deposit',  icon:'fa-plus',       name:'Пополнение',    detail:'Зачисление средств', prefix:'+', amtCls:'positive' },
    withdrawal: { cls:'withdraw', icon:'fa-arrow-up',   name:'Вывод средств', detail:'Списание средств',   prefix:'-', amtCls:'neutral'  },
    in:         { cls:'in',       icon:'fa-arrow-down', prefix:'+', amtCls:'positive' },
    out:        { cls:'out',      icon:'fa-arrow-up',   prefix:'-', amtCls:'negative' },
};

function applyFilter() {
    const f = activeFilter;
    const q = (document.getElementById('history-search').value || '').toLowerCase();
    const filtered = allTx.filter(tx => {
        if (f === 'in'         && tx.direction !== 'in')    return false;
        if (f === 'out'        && tx.direction !== 'out')   return false;
        if (f === 'deposit'    && tx.type !== 'deposit')    return false;
        if (f === 'withdrawal' && tx.type !== 'withdrawal') return false;
        if (q) {
            const src = [tx.sender_username, tx.receiver_username, tx.sender_email, tx.receiver_email, tx.description]
                .filter(Boolean).join(' ').toLowerCase();
            if (!src.includes(q)) return false;
        }
        return true;
    });
    renderTx(filtered);
}

function setFilter(btn, f) {
    document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = f;
    applyFilter();
}

// Fallback: addEventListener для кнопок без onclick
document.querySelectorAll('.ftab:not([onclick])').forEach(btn => {
    btn.addEventListener('click', function () { setFilter(this, this.dataset.f); });
});

function renderTx(list) {
    const el = document.getElementById('tx-list');
    if (!list.length) {
        el.innerHTML = `<div class="tx-empty"><i class="fas fa-receipt"></i><p>Нет транзакций</p></div>`;
        return;
    }
    const frag = list.map((tx, i) => {
        const cfg = tx.type === 'deposit' ? TX_ICONS.deposit
                  : tx.type === 'withdrawal' ? TX_ICONS.withdrawal
                  : tx.direction === 'in' ? TX_ICONS.in : TX_ICONS.out;
        const name   = cfg.name   || (tx.direction === 'in' ? tx.sender_username   : tx.receiver_username) || '—';
        const detail = cfg.detail || (tx.direction === 'in'
            ? [tx.sender_email, tx.description].filter(Boolean).join(' · ')
            : [tx.receiver_email, tx.description].filter(Boolean).join(' · ')) || '';
        return `<div class="tx-item" style="--ti:${Math.min(i * .04, .4)}s">
            <div class="tx-icon ${cfg.cls}"><i class="fas ${cfg.icon}"></i></div>
            <div class="tx-info">
                <div class="tx-name">${escapeHtml(name)}</div>
                <div class="tx-detail">${detail ? escapeHtml(detail) : '&nbsp;'}</div>
            </div>
            <div class="tx-right">
                <div class="tx-amount ${cfg.amtCls}">${cfg.prefix}$${fmt(tx.amount)}</div>
                <div class="tx-time">${fmtTime(tx.created_at)}</div>
            </div>
        </div>`;
    }).join('');
    el.innerHTML = frag;
}

// ===== MODALS =====
function openModal(name) {
    document.getElementById('modal-' + name).classList.add('open');
    if (name === 'transfer') {
        const el = document.getElementById('transfer-avail');
        if (el) el.textContent = '$' + fmt(currentBalance);
    }
}

function openAccountPanel() {
    switchPanel('account');
    loadSecuritySessions();
    try {
        const u = currentUser || {};
        const name = u.username || '';
        const color = avatarColor(name || '?');
        const letter = (name || '?')[0].toUpperCase();
        const pfAv = document.getElementById('pf-avatar');
        if (pfAv) { pfAv.textContent = letter; pfAv.style.background = color; }
        const pfUn = document.getElementById('pf-username');
        if (pfUn) pfUn.textContent = name || '—';
        const pfIUn = document.getElementById('pf-info-username');
        if (pfIUn) pfIUn.textContent = name || '—';
        const pfIEm = document.getElementById('pf-info-email');
        if (pfIEm) pfIEm.textContent = u.email || '—';
        const accCurUn = document.getElementById('acc-cur-username');
        if (accCurUn) accCurUn.textContent = name || '—';
        const accCurEm = document.getElementById('acc-cur-email');
        if (accCurEm) accCurEm.textContent = u.email || '—';
        ['pf-cur-pass','pf-new-pass','pf-confirm-pass','pf-new-username','pf-user-pass','pf-new-email','pf-email-pass'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        document.querySelectorAll('.acc-card').forEach(el => el.classList.remove('open'));
        const bar = document.getElementById('pf-strength-bar');
        if (bar) { bar.style.width = '0'; bar.style.background = ''; }
    } catch(e) { console.error('openAccountPanel:', e); }
}

// ===== PROFILE =====
function pfMsg(text, type) {
    const el = document.getElementById('pf-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'pf-msg' + (type ? ' ' + type : '');
}

function togglePfPass(id, btn) {
    const inp = document.getElementById(id);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.querySelector('i').className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
}

function checkPfStrength(val) {
    const bar = document.getElementById('pf-strength-bar');
    if (!bar) return;
    let score = 0;
    if (val.length >= 8)  score++;
    if (val.length >= 12) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    const colors = ['#DC2626','#EA580C','#EAB308','#16A34A','#16A34A'];
    const widths  = ['20%','40%','60%','80%','100%'];
    bar.style.width      = val ? (widths[score - 1] || '10%') : '0';
    bar.style.background = val ? (colors[score - 1] || '#DC2626') : 'transparent';
}

async function loadSessions() {
    const list  = document.getElementById('pf-sessions-list');
    const count = document.getElementById('pf-sessions-count');
    if (!list) return;
    list.innerHTML = '<div class="pf-sessions-loading"><i class="fas fa-spinner fa-spin"></i> Загрузка...</div>';

    try {
        const data = await api('GET', '/api/auth/sessions');
        const sessions = data.sessions || [];
        if (count) count.textContent = sessions.length;

        if (!sessions.length) {
            list.innerHTML = '<div class="pf-sessions-loading">Нет активных сессий</div>';
            return;
        }

        const ICONS = { mobile:'fa-mobile-screen', tablet:'fa-tablet', desktop:'fa-desktop' };

        list.innerHTML = sessions.map(s => {
            const icon = ICONS[s.device_type] || 'fa-desktop';
            const ago  = fmtTime(s.last_seen);
            const loc  = [s.flag, s.city, s.country].filter(Boolean).join(' ');
            return `
            <div class="pf-session-item${s.is_current ? ' current' : ''}" id="sess-${s.id}">
                <div class="pf-session-icon ${s.device_type || 'desktop'}">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="pf-session-info">
                    <div class="pf-session-name">
                        ${s.device_name || 'Устройство'}
                        ${s.is_current ? '<span class="pf-current-badge">Текущий</span>' : ''}
                    </div>
                    <div class="pf-session-meta">
                        ${loc ? `<span><i class="fas fa-location-dot"></i>${escapeHtml(loc)}</span>` : ''}
                        ${s.ip ? `<span><i class="fas fa-network-wired"></i>${escapeHtml(s.ip)}</span>` : ''}
                        <span><i class="fas fa-clock"></i>${ago}</span>
                    </div>
                </div>
                ${!s.is_current ? `
                <button class="pf-session-revoke" onclick="revokeSession(${s.id})" title="Завершить сессию">
                    <i class="fas fa-xmark"></i>
                </button>` : ''}
            </div>`;
        }).join('');
    } catch {
        list.innerHTML = '<div class="pf-sessions-loading">Ошибка загрузки</div>';
    }
}

async function revokeSession(id) {
    const item = document.getElementById('sess-' + id);
    if (item) { item.style.opacity = '.4'; item.style.pointerEvents = 'none'; }
    try {
        const res = await api('DELETE', `/api/auth/sessions/${id}`);
        if (res.success) {
            item?.remove();
            const list  = document.getElementById('pf-sessions-list');
            const count = document.getElementById('pf-sessions-count');
            if (count) count.textContent = Math.max(0, parseInt(count.textContent || '0') - 1);
            if (list && !list.querySelector('.pf-session-item'))
                list.innerHTML = '<div class="pf-sessions-loading">Нет активных сессий</div>';
        } else {
            if (item) { item.style.opacity = '1'; item.style.pointerEvents = ''; }
        }
    } catch {
        if (item) { item.style.opacity = '1'; item.style.pointerEvents = ''; }
    }
}

async function changePassword() {
    const cur  = document.getElementById('pf-cur-pass')?.value  || '';
    const nw   = document.getElementById('pf-new-pass')?.value  || '';
    const conf = document.getElementById('pf-confirm-pass')?.value || '';
    const btn  = document.getElementById('pf-submit');

    if (!cur || !nw || !conf) return pfMsg('Заполните все поля', 'err');
    if (nw.length < 8)        return pfMsg('Новый пароль минимум 8 символов', 'err');
    if (nw !== conf)          return pfMsg('Пароли не совпадают', 'err');

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение...';
    pfMsg('', '');

    try {
        const res  = await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: nw });
        if (res.success) {
            pfMsg('Пароль успешно изменён!', 'ok');
            ['pf-cur-pass','pf-new-pass','pf-confirm-pass'].forEach(id => {
                const el = document.getElementById(id); if (el) el.value = '';
            });
            const bar = document.getElementById('pf-strength-bar');
            if (bar) bar.style.width = '0';
        } else {
            pfMsg(res.error || 'Ошибка', 'err');
        }
    } catch {
        pfMsg('Ошибка соединения', 'err');
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-shield-alt"></i> Сохранить пароль';
}
function toggleAcc(name) {
    const item = document.getElementById('acc-' + name);
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.acc-card').forEach(el => el.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
}

function pfMsg2(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'acc-msg' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
}

async function changeUsername(btn) {
    const newUser = (document.getElementById('pf-new-username')?.value || '').trim();
    const pass    =  document.getElementById('pf-user-pass')?.value || '';
    pfMsg2('pf-user-msg', '', '');

    if (!newUser) return pfMsg2('pf-user-msg', 'Введите новый логин', 'err');
    if (!pass)    return pfMsg2('pf-user-msg', 'Введите текущий пароль', 'err');

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение...';

    try {
        const res = await api('POST', '/api/auth/change-username', { username: newUser, password: pass });
        if (res.success) {
            pfMsg2('pf-user-msg', 'Логин успешно изменён!', 'ok');
            document.getElementById('pf-new-username').value = '';
            document.getElementById('pf-user-pass').value    = '';
            currentUser.username = newUser;
            const color = avatarColor(newUser);
            setAllAvatars(color, newUser[0].toUpperCase());
            const un = document.getElementById('pf-username');    if (un) un.textContent = newUser;
            const ui = document.getElementById('pf-info-username'); if (ui) ui.textContent = newUser;
            const su = document.getElementById('sb-username');    if (su) su.textContent = newUser;
        } else {
            pfMsg2('pf-user-msg', res.error || 'Ошибка', 'err');
        }
    } catch { pfMsg2('pf-user-msg', 'Ошибка соединения', 'err'); }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-user-check"></i> Сохранить логин';
}

async function sendEmailCode(btn) {
    const newEmail = (document.getElementById('pf-new-email')?.value || '').trim();
    const pass     =  document.getElementById('pf-email-pass')?.value || '';
    pfMsg2('pf-email-msg', '', '');

    if (!newEmail) return pfMsg2('pf-email-msg', 'Введите новый email', 'err');
    if (!pass)     return pfMsg2('pf-email-msg', 'Введите текущий пароль', 'err');

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Отправка...';

    try {
        const res = await api('POST', '/api/auth/send-email-code', { email: newEmail, password: pass });
        if (res.success) {
            document.getElementById('email-step1').style.display = 'none';
            document.getElementById('email-step2').style.display = 'flex';
            document.getElementById('pf-email-code').value = '';
            pfMsg2('pf-email-code-msg', '', '');
        } else {
            pfMsg2('pf-email-msg', res.error || 'Ошибка', 'err');
        }
    } catch { pfMsg2('pf-email-msg', 'Ошибка соединения', 'err'); }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Отправить код';
}

async function confirmEmailCode(btn) {
    const code = (document.getElementById('pf-email-code')?.value || '').trim();
    pfMsg2('pf-email-code-msg', '', '');

    if (!code) return pfMsg2('pf-email-code-msg', 'Введите код из письма', 'err');

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Проверка...';

    try {
        const res = await api('POST', '/api/auth/change-email', { code });
        if (res.success) {
            const newEmail = (document.getElementById('pf-new-email')?.value || '').trim();
            pfMsg2('pf-email-code-msg', 'Email успешно изменён!', 'ok');
            currentUser.email = newEmail;
            ['pf-info-email','acc-cur-email','acc-email-display'].forEach(id => {
                const el = document.getElementById(id); if (el) el.textContent = newEmail;
            });
            setTimeout(() => {
                document.getElementById('email-step1').style.display = 'flex';
                document.getElementById('email-step2').style.display = 'none';
                document.getElementById('pf-new-email').value  = '';
                document.getElementById('pf-email-pass').value = '';
                document.getElementById('pf-email-code').value = '';
                pfMsg2('pf-email-code-msg', '', '');
                document.querySelectorAll('.acc-card').forEach(el => el.classList.remove('open'));
            }, 2000);
        } else {
            pfMsg2('pf-email-code-msg', res.error || 'Неверный код', 'err');
        }
    } catch { pfMsg2('pf-email-code-msg', 'Ошибка соединения', 'err'); }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-check"></i> Подтвердить';
}

async function resendEmailCode(btn) {
    document.getElementById('email-step1').style.display = 'flex';
    document.getElementById('email-step2').style.display = 'none';
    document.getElementById('pf-email-code').value = '';
    pfMsg2('pf-email-code-msg', '', '');
    pfMsg2('pf-email-msg', '', '');
    document.getElementById('pf-email-send-btn').click();
}

function closeModal(name) {
    document.getElementById('modal-' + name).classList.remove('open');
    document.querySelectorAll(`#modal-${name} .modal-msg`).forEach(el => { el.textContent = ''; el.className = 'modal-msg'; });
}

document.querySelectorAll('.modal-overlay').forEach(el =>
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); })
);

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
});

function setAmt(id, v) { document.getElementById(id).value = v; }

function setMsg(id, text, type = 'err') {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'modal-msg ' + type;
}

// ===== DEPOSIT =====
async function doDeposit() {
    const amount = parseFloat(document.getElementById('deposit-amount').value);
    if (!amount || amount <= 0) return setMsg('deposit-msg', 'Введите корректную сумму');
    withBtn(document.getElementById('deposit-btn'), async () => {
        const data = await api('POST', '/api/wallet/deposit', { amount });
        if (data.success) {
            closeModal('deposit');
            document.getElementById('deposit-amount').value = '';
            setBalance(data.balance);
            showSuccess('Баланс пополнен!', `+$${fmt(amount)} зачислено на ваш счёт`);
            loadInit();
        } else { setMsg('deposit-msg', data.error || 'Ошибка'); }
    });
}

// ===== WITHDRAW =====
async function doWithdraw() {
    const amount = parseFloat(document.getElementById('withdraw-amount').value);
    if (!amount || amount <= 0)   return setMsg('withdraw-msg', 'Введите корректную сумму');
    if (amount > currentBalance)  return setMsg('withdraw-msg', `Недостаточно средств (доступно $${fmt(currentBalance)})`);
    withBtn(document.getElementById('withdraw-btn'), async () => {
        const data = await api('POST', '/api/wallet/withdraw', { amount });
        if (data.success) {
            closeModal('withdraw');
            document.getElementById('withdraw-amount').value = '';
            setBalance(data.balance);
            showSuccess('Вывод выполнен!', `$${fmt(amount)} списано с вашего счёта`);
            loadInit();
        } else { setMsg('withdraw-msg', data.error || 'Ошибка'); }
    });
}

// ===== FIND USER =====
let findTimer, foundUser = null;

function debounceFind() {
    clearTimeout(findTimer);
    foundUser = null;
    const q = document.getElementById('send-to').value.trim();
    const preview = document.getElementById('recipient-preview');
    if (!q || q.replace('@', '').length < 2) { preview.innerHTML = ''; return; }
    preview.innerHTML = '<div class="rp-searching"><i class="fas fa-spinner fa-spin"></i> Поиск...</div>';
    findTimer = setTimeout(() => findUser(q), 400);
}

async function findUser(q) {
    const preview = document.getElementById('recipient-preview');
    const data = await api('GET', `/api/wallet/find-user?q=${encodeURIComponent(q)}`);
    if (!data.found) {
        preview.innerHTML = '<div class="rp-notfound"><i class="fas fa-circle-xmark"></i> Пользователь не найден</div>';
        return;
    }
    foundUser = data;
    const wrap = document.createElement('div');
    wrap.className = 'rp-found';
    wrap.appendChild(makeAvatar(data.username, 34));
    const info = document.createElement('div');
    info.innerHTML = `<div class="rp-name">${escapeHtml(data.username)}</div><div class="rp-email">${escapeHtml(data.email)}</div>`;
    wrap.appendChild(info);
    const check = document.createElement('i');
    check.className = 'fas fa-circle-check rp-check';
    wrap.appendChild(check);
    preview.innerHTML = '';
    preview.appendChild(wrap);
}

// ===== TRANSFER =====
let pendingTransfer = null;

function initiateTransfer() {
    if (!foundUser)              return flash('Укажите получателя');
    const amount = parseFloat(document.getElementById('send-amount').value);
    if (!amount || amount <= 0)  return flash('Укажите корректную сумму');
    if (amount > currentBalance) return flash(`Недостаточно средств (доступно $${fmt(currentBalance)})`);
    const note = document.getElementById('send-note').value.trim();
    pendingTransfer = { to: foundUser.email, amount, note, receiverUsername: foundUser.username };

    document.getElementById('cf-sender-av').replaceChildren(makeAvatar(currentUser.username, 56));
    document.getElementById('cf-receiver-av').replaceChildren(makeAvatar(foundUser.username, 56));
    document.getElementById('cf-sender-name').textContent   = currentUser.username;
    document.getElementById('cf-receiver-name').textContent = foundUser.username;
    document.getElementById('cf-amount').textContent        = '$' + fmt(amount);

    const noteRow = document.getElementById('cf-note-row');
    if (note) { document.getElementById('cf-note').textContent = note; noteRow.style.display = 'flex'; }
    else { noteRow.style.display = 'none'; }

    closeModal('transfer');
    openModal('confirm');
}

async function doTransfer() {
    if (!pendingTransfer) return;
    const { to, amount, note } = pendingTransfer;
    withBtn(document.getElementById('confirm-btn'), async () => {
        const data = await api('POST', '/api/wallet/transfer', { to, amount, description: note });
        if (data.success) {
            closeModal('confirm');
            ['send-to','send-amount','send-note'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('recipient-preview').innerHTML = '';
            foundUser = null; pendingTransfer = null;
            showSuccess('Перевод отправлен!', `$${fmt(amount)} → ${data.receiver_username}`);
            loadInit();
        } else {
            setMsg('confirm-msg', data.error || 'Ошибка перевода');
        }
    });
}

// ===== SUCCESS =====
function showSuccess(title, sub) {
    document.getElementById('success-title').textContent = title;
    document.getElementById('success-sub').textContent   = sub;
    openModal('success');
}

// ===== FLASH =====
function flash(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(10px);background:rgba(15,15,30,0.95);border:1px solid rgba(255,71,87,.35);color:#ff4757;padding:12px 24px;border-radius:12px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:all .3s;pointer-events:none;white-space:nowrap;box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(12px)`;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => {
        el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(10px)';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

// ===== SECURITY PANEL SESSIONS =====
const SESSION_ICONS = { mobile:'fa-mobile-screen-button', tablet:'fa-tablet-screen-button', desktop:'fa-desktop' };

function renderSecSession(s) {
    const icon = SESSION_ICONS[s.device_type] || 'fa-desktop';
    const loc  = [s.flag, s.city, s.country].filter(Boolean).join(' ');
    const time = s.is_current ? '<span class="sec-sess-live"><i class="fas fa-circle"></i> Активна сейчас</span>' : fmtTime(s.last_seen);
    return `<div class="sec-sess-card${s.is_current ? ' current' : ''}">
        <div class="sec-sess-icon ${s.device_type || 'desktop'}">
            <i class="fas ${icon}"></i>
        </div>
        <div class="sec-sess-body">
            <div class="sec-sess-name">
                ${s.device_name || 'Устройство'}
                ${s.is_current ? '<span class="sec-sess-badge">Текущий</span>' : ''}
            </div>
            <div class="sec-sess-meta">
                ${loc ? `<span><i class="fas fa-location-dot"></i>${escapeHtml(loc)}</span>` : ''}
                ${s.ip ? `<span><i class="fas fa-network-wired"></i>${escapeHtml(s.ip)}</span>` : ''}
            </div>
            <div class="sec-sess-time">${time}</div>
        </div>
        ${!s.is_current
            ? `<button class="sec-sess-kill" onclick="terminateSecSession(${s.id},this)" title="Завершить"><i class="fas fa-xmark"></i></button>`
            : `<div class="sec-sess-dot"></div>`}
    </div>`;
}

async function loadSecuritySessions() {
    const list   = document.getElementById('sessions-list');
    const footer = document.getElementById('sessions-footer');
    if (!list) return;
    list.innerHTML = `<div class="sec-sess-skeleton">${'<div class="sec-sess-sk-card"><div class="sk-icon"></div><div class="sk-lines"><div class="sk-line w70"></div><div class="sk-line w50"></div><div class="sk-line w40"></div></div></div>'.repeat(2)}</div>`;
    if (footer) footer.style.display = 'none';

    try {
        const data = await api('GET', '/api/auth/sessions');
        const sessions = data?.sessions;
        if (!sessions) {
            list.innerHTML = '<div class="sec-sess-empty"><i class="fas fa-circle-xmark"></i><p>Ошибка загрузки сеансов</p></div>';
            return;
        }
        if (!sessions.length) {
            list.innerHTML = '<div class="sec-sess-empty"><i class="fas fa-shield-halved"></i><p>Нет активных сеансов</p></div>';
            return;
        }
        list.innerHTML = sessions.map(renderSecSession).join('');
        if (footer) footer.style.display = sessions.some(s => !s.is_current) ? 'block' : 'none';
    } catch {
        list.innerHTML = '<div class="sec-sess-empty"><i class="fas fa-wifi"></i><p>Нет соединения с сервером</p></div>';
    }
}

async function terminateSecSession(id, btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
        const data = await api('DELETE', `/api/auth/sessions/${id}`);
        if (data.success) {
            loadSecuritySessions();
            loadSessions(); // обновить и в профиле если открыт
        } else {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-xmark"></i>';
            flash(data.error || 'Ошибка');
        }
    } catch {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-xmark"></i>';
        flash('Ошибка соединения');
    }
}

async function terminateAllSessions(btn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Завершение...';
    try {
        const data = await api('DELETE', '/api/auth/sessions');
        if (data.success) {
            loadSecuritySessions();
            loadSessions();
        } else {
            btn.innerHTML = orig;
            flash(data.error || 'Ошибка');
        }
    } catch {
        btn.innerHTML = orig;
        flash('Ошибка соединения');
    } finally {
        btn.disabled = false;
    }
}

// ===== SIDEBAR / PANELS =====
// ===== CARD PANEL =====
function detectCardType(digits) {
    if (!digits || digits.length < 1) return null;
    if (/^4/.test(digits))       return 'visa';
    if (/^5[1-5]/.test(digits))  return 'mastercard';
    if (/^2[2-7]/.test(digits)) {
        const n = parseInt(digits.slice(0, 4).padEnd(4, '0'));
        if (n >= 2200 && n <= 2204) return 'mir';
        if (n >= 2221 && n <= 2720) return 'mastercard';
    }
    if (/^(62|81)/.test(digits)) return 'unionpay';
    return null;
}

const _cdNames = { visa:'VISA', mastercard:'Mastercard', mir:'МИР', unionpay:'UnionPay' };
function showDetectedCard(type) {
    const el = document.getElementById('cp-detected');
    if (!el) return;
    if (!type) { el.style.display = 'none'; return; }
    el.className = 'cp-detected cd-' + type;
    el.style.display = 'flex';
    el.innerHTML = `<span class="cd-badge">${_cdNames[type]}</span><span>тип определён автоматически</span>`;
}

function fmtCardNum(input) {
    const v = input.value.replace(/\D/g, '').slice(0, 16);
    input.value = v.match(/.{1,4}/g)?.join(' ') || v;
    const type = detectCardType(v);
    if (type) _currentCardType = type;
    showDetectedCard(type);
}

function fmtExpiry(input) {
    let v = input.value.replace(/\D/g, '').slice(0, 4);
    if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
    input.value = v;
}

let _lastCardType    = 'visa';
let _currentCardType = 'visa';
function updateCard() {
    const type   = _currentCardType;
    const raw    = (document.getElementById('cp-number')?.value || '').replace(/\s/g, '');
    const holder = (document.getElementById('cp-holder')?.value || '').trim();
    const exp    = document.getElementById('cp-expiry')?.value  || '';

    const card = document.getElementById('cp-card');
    if (!card) return;

    const isEmpty  = !raw && !holder && !exp;
    const wasEmpty = card.classList.contains('empty');

    if (isEmpty) {
        if (!wasEmpty) {
            card.classList.add('changing');
            setTimeout(() => card.classList.remove('changing'), 560);
        }
        card.className = 'cp-card empty';
        _lastCardType = type;
        const logo = document.getElementById('cp-logo');
        if (logo) logo.textContent = '';
        const numEl = document.getElementById('cp-num');
        if (numEl) numEl.textContent = '•••• •••• •••• ••••';
        const nameEl = document.getElementById('cp-name');
        if (nameEl) nameEl.textContent = '';
        const expEl = document.getElementById('cp-exp');
        if (expEl) expEl.textContent = '';
        return;
    }

    if (type !== _lastCardType || wasEmpty) {
        card.classList.add('changing');
        setTimeout(() => card.classList.remove('changing'), 560);
        _lastCardType = type;
    }
    card.className = 'cp-card ' + type;

    const logos = { visa:'VISA', mastercard:'Mastercard', mir:'МИР', unionpay:'UnionPay' };
    const logo  = document.getElementById('cp-logo');
    if (logo) logo.textContent = logos[type] || 'VISA';

    let display = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) display += ' ';
        if (i < raw.length) display += (i >= 4 && i < 12) ? '•' : raw[i];
        else display += '•';
    }
    const numEl = document.getElementById('cp-num');
    if (numEl) numEl.textContent = display;

    const nameEl = document.getElementById('cp-name');
    if (nameEl) nameEl.textContent = holder || 'ВАШЕ ИМЯ';

    const expEl = document.getElementById('cp-exp');
    if (expEl) expEl.textContent = exp || 'ММ/ГГ';
}

function saveCard() {
    const number = (document.getElementById('cp-number')?.value || '').replace(/\s/g,'');
    const holder = (document.getElementById('cp-holder')?.value || '').trim();
    const expiry =  document.getElementById('cp-expiry')?.value || '';
    const msg    =  document.getElementById('cp-msg');

    const err = (t) => { if (msg) { msg.textContent=t; msg.className='cp-msg err'; } };
    if (number.length < 16) return err('Введите полный номер карты');
    if (!holder)             return err('Введите держателя карты');
    if (expiry.length < 5)  return err('Введите срок действия (ММ/ГГ)');

    const data = {
        type:   _currentCardType,
        number: document.getElementById('cp-number')?.value,
        holder, expiry,
    };
    try { localStorage.setItem('bt_card', JSON.stringify(data)); } catch {}
    if (msg) { msg.textContent = '✓ Карта сохранена!'; msg.className = 'cp-msg ok'; }
    setTimeout(() => { if (msg) { msg.textContent=''; msg.className='cp-msg'; } }, 3000);
}

function clearCard() {
    ['cp-number','cp-holder','cp-expiry','cp-cvv'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    _currentCardType = 'visa';
    showDetectedCard(null);
    updateCard();
    localStorage.removeItem('bt_card');
}

function loadCard() {
    try {
        const saved = localStorage.getItem('bt_card');
        if (!saved) return;
        const c = JSON.parse(saved);
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        _currentCardType = c.type || 'visa';
        set('cp-number', c.number);
        set('cp-holder', c.holder);
        set('cp-expiry', c.expiry);
        showDetectedCard(detectCardType((c.number || '').replace(/\s/g, '')));
        updateCard();
    } catch {}
}

function switchPanel(name) {
    document.querySelectorAll('.d-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sb-item').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('panel-' + name);
    if (panel) panel.classList.add('active');
    document.querySelectorAll(`.sb-item[data-p="${name}"]`).forEach(b => b.classList.add('active'));
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sb-overlay').classList.remove('open');
    if (name === 'card') loadCard();
    if (name === 'trader') loadTraderMethods();
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sb-overlay').classList.toggle('open');
}

// ===== TRADER PANEL =====
let _trMethodType = 'card';

function showTraderNav(role) {
    const show = role === 'trader' || role === 'admin';
    document.querySelectorAll('.sb-trader-section').forEach(el => {
        el.style.display = show ? '' : 'none';
    });
}

let _trVerified = false;

async function loadTraderMethods() {
    const list = document.getElementById('tr-list');
    const empty = document.getElementById('tr-empty');
    const counter = document.getElementById('tr-count');
    if (!list) return;
    loadPassportStatus();
    try {
        const data = await api('GET', '/api/trader/methods');
        if (!data.success) return;
        const methods = data.methods || [];
        if (counter) counter.textContent = methods.length;
        if (!methods.length) {
            list.innerHTML = '';
            if (empty) { empty.style.display = ''; list.appendChild(empty); }
            return;
        }
        if (empty) empty.style.display = 'none';
        list.innerHTML = methods.map(m => renderMethod(m, data.active_id)).join('');
    } catch(e) { console.error('loadTraderMethods:', e); }
}

let _trPassportFile = null;

async function loadAuthedImage(url, imgEl) {
    if (!imgEl) return;
    try {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'ngrok-skip-browser-warning': '1' } });
        if (!res.ok) return;
        imgEl.src = URL.createObjectURL(await res.blob());
    } catch(e) { console.error('loadAuthedImage:', e); }
}

async function loadPassportStatus() {
    const wrap     = document.getElementById('tr-kyc');
    const elNone    = document.getElementById('tr-kyc-none');
    const elPending = document.getElementById('tr-kyc-pending');
    const elOk      = document.getElementById('tr-kyc-verified');
    const addBtn    = document.getElementById('tr-add-btn');
    if (!wrap) return;
    try {
        const data = await api('GET', '/api/auth/passport');
        if (!data.success) return;
        _trVerified = data.status === 'verified';
        wrap.style.display = '';
        elNone.style.display    = data.status === 'none'     ? '' : 'none';
        elPending.style.display = data.status === 'pending'  ? '' : 'none';
        elOk.style.display      = data.status === 'verified' ? '' : 'none';
        if (addBtn) addBtn.disabled = !_trVerified;

        if (data.status === 'pending')  loadAuthedImage('/api/auth/passport/image', document.getElementById('tr-kyc-pending-thumb'));
        if (data.status === 'verified') loadAuthedImage('/api/auth/passport/image', document.getElementById('tr-kyc-verified-thumb'));
    } catch(e) { console.error('loadPassportStatus:', e); }
}

function onPassportFileChosen(inp) {
    const file = inp.files?.[0];
    const submitBtn = document.getElementById('tr-kyc-submit-btn');
    const msg = document.getElementById('tr-kyc-msg');
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
        if (msg) { msg.textContent = 'Файл слишком большой (макс. 8 МБ)'; msg.className = 'tr-msg err'; }
        inp.value = '';
        return;
    }
    _trPassportFile = file;
    if (msg) { msg.textContent = ''; msg.className = 'tr-msg'; }
    const preview = document.getElementById('tr-kyc-preview');
    const empty   = document.getElementById('tr-kyc-drop-empty');
    preview.src = URL.createObjectURL(file);
    preview.style.display = '';
    if (empty) empty.style.display = 'none';
    if (submitBtn) submitBtn.disabled = false;
}

async function submitPassport(btn) {
    const msg = document.getElementById('tr-kyc-msg');
    if (!_trPassportFile) { if (msg) { msg.textContent = 'Выберите фото паспорта'; msg.className = 'tr-msg err'; } return; }

    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Отправка...';
    btn.disabled = true;

    const fd = new FormData();
    fd.append('photo', _trPassportFile);

    let data;
    try {
        const res = await fetch('/api/auth/passport', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'ngrok-skip-browser-warning': '1' },
            body: fd,
        });
        data = await res.json();
    } catch(e) {
        data = { success: false, error: 'Ошибка сети' };
    }

    btn.innerHTML = orig; btn.disabled = false;

    if (data.success) {
        if (msg) { msg.textContent = ''; msg.className = 'tr-msg'; }
        _trPassportFile = null;
        loadPassportStatus();
    } else if (msg) {
        msg.textContent = data.error || 'Ошибка'; msg.className = 'tr-msg err';
    }
}

function fmtCard(v) {
    return v.replace(/\D/g,'').replace(/(.{4})/g,'$1 ').trim();
}

function fmtPhone(v) {
    const d = v.replace(/\D/g,'');
    if (d.length === 11) return '+7 ' + d.slice(1,4) + ' ' + d.slice(4,7) + '-' + d.slice(7,9) + '-' + d.slice(9);
    return v;
}

function fmtMoney(v) {
    return Math.round(parseFloat(v) || 0).toLocaleString('ru-RU');
}

function renderMethod(m, activeId) {
    const isCard    = m.type === 'card';
    const display   = isCard ? fmtCard(m.value) : fmtPhone(m.value);
    const isActive  = m.id === activeId;
    const overLimit = !!m.over_limit;
    let badge = '';
    if (overLimit)      badge = `<span class="tr-method-badge limit"><i class="fas fa-ban"></i> Лимит исчерпан</span>`;
    else if (isActive)  badge = `<span class="tr-method-badge active"><i class="fas fa-bolt"></i> Активен</span>`;
    return `
    <div class="tr-method ${m.is_active ? '' : 'inactive'}" id="trm-${m.id}">
        <div class="tr-method-icon ${m.type}">
            <i class="fas fa-${isCard ? 'credit-card' : 'mobile-alt'}"></i>
        </div>
        <div class="tr-method-info">
            <div class="tr-method-value">${escapeHtml(display)} ${badge}</div>
            <div class="tr-method-meta">
                ${m.bank ? `<span class="tr-method-bank">${escapeHtml(m.bank)}</span>` : ''}
                ${m.holder ? `<span class="tr-method-holder">${escapeHtml(m.holder)}</span>` : ''}
                <span class="tr-method-limit">${fmtMoney(m.daily_used)} / ${fmtMoney(m.daily_limit)} ₽ сутки</span>
            </div>
        </div>
        <div class="tr-method-actions">
            <label class="tr-toggle" title="${m.is_active ? 'Выключить' : 'Включить'}">
                <input type="checkbox" ${m.is_active ? 'checked' : ''} onchange="toggleMethod(${m.id}, this)">
                <span class="tr-toggle-slider"></span>
            </label>
            <button class="tr-del-btn" onclick="deleteMethod(${m.id})" title="Удалить">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    </div>`;
}

async function toggleMethod(id, cb) {
    const data = await api('PATCH', `/api/trader/methods/${id}/toggle`);
    if (!data.success) {
        cb.checked = !cb.checked;
        if (data.error) flash(data.error);
        return;
    }
    loadTraderMethods();
}

async function deleteMethod(id) {
    if (!confirm('Удалить реквизит?')) return;
    const data = await api('DELETE', `/api/trader/methods/${id}`);
    if (data.success) loadTraderMethods();
}

function openAddMethod() {
    if (!_trVerified) { flash('Пройдите верификацию паспорта, чтобы добавить реквизит'); return; }
    document.getElementById('modal-trader-add')?.classList.add('open');
}

function closeAddMethod() {
    document.getElementById('modal-trader-add')?.classList.remove('open');
    const msg = document.getElementById('tr-form-msg');
    if (msg) { msg.textContent = ''; msg.className = 'tr-msg'; }
    const inp = document.getElementById('tr-value');
    if (inp) inp.value = '';
    const holder = document.getElementById('tr-holder');
    if (holder) holder.value = '';
    const bankInp  = document.getElementById('tr-bank');
    const bankWrap = document.getElementById('tr-bank-auto');
    const bankLabel = document.getElementById('tr-bank-auto-name');
    const bankBadge = document.getElementById('tr-bank-auto-badge');
    if (bankInp) bankInp.value = '';
    if (bankWrap) bankWrap.classList.remove('detected');
    if (bankLabel) bankLabel.textContent = 'Введите номер карты';
    if (bankBadge) bankBadge.style.display = 'none';
    const expInp = document.getElementById('tr-expiry');
    if (expInp) expInp.value = '';
    const expDisp = document.getElementById('tr-mini-exp');
    if (expDisp) expDisp.textContent = 'ММ/ГГ';
    const cardEl = document.getElementById('tr-card');
    if (cardEl) cardEl.className = 'tr-card';
    _trLastType = null;
    // Сброс SBP
    document.querySelectorAll('.tr-sbp-bank-btn').forEach(b => b.classList.remove('selected'));
    const sbpBankInp = document.getElementById('tr-sbp-bank');
    if (sbpBankInp) sbpBankInp.value = '';
    updateSbpPreview();
    trUpdateCardPreview();
}

function trHolderInput() {
    const el = document.getElementById('tr-holder');
    if (el) el.value = el.value.toUpperCase();
    if (_trMethodType === 'card') trUpdateCardPreview();
    else updateSbpPreview();
}

function updateSbpPreview() {
    const inp      = document.getElementById('tr-value');
    const holderEl = document.getElementById('tr-holder');
    const phoneDisp = document.getElementById('tr-sbp-phone');
    const nameDisp  = document.getElementById('tr-sbp-name');
    const bankDisp  = document.getElementById('tr-sbp-bank-disp');
    const bank = document.getElementById('tr-sbp-bank')?.value || '';
    if (phoneDisp) phoneDisp.textContent = (inp?.value || '').trim() || '+7 (___) ___-__-__';
    if (nameDisp)  nameDisp.textContent  = (holderEl?.value || '').trim() || '—';
    if (bankDisp)  bankDisp.textContent  = bank || '—';
}

function selectSbpBank(btn, name) {
    document.querySelectorAll('.tr-sbp-bank-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const inp = document.getElementById('tr-sbp-bank');
    if (inp) inp.value = name;
    updateSbpPreview();
}

function setMethodType(type) {
    _trMethodType = type;
    document.getElementById('tab-card').classList.toggle('active', type === 'card');
    document.getElementById('tab-phone').classList.toggle('active', type === 'phone');

    const numLbl    = document.getElementById('tr-lbl-num');
    const holderLbl = document.getElementById('tr-lbl-holder');
    const inp       = document.getElementById('tr-value');
    const expiry    = document.getElementById('tr-field-expiry');
    const bankAuto  = document.getElementById('tr-field-bank');
    const sbpBank   = document.getElementById('tr-field-sbp-bank');
    const cardScene = document.getElementById('tr-card-scene');
    const sbpScene  = document.getElementById('tr-sbp-scene');

    if (type === 'card') {
        if (numLbl)    numLbl.textContent    = 'Номер карты';
        if (holderLbl) holderLbl.textContent = 'Держатель карты';
        if (inp) { inp.placeholder = '0000 0000 0000 0000'; inp.maxLength = 19; inp.inputMode = 'numeric'; }
        if (cardScene) cardScene.style.display = '';
        if (sbpScene)  sbpScene.style.display  = 'none';
        if (expiry)    expiry.style.display    = '';
        if (bankAuto)  bankAuto.style.display  = '';
        if (sbpBank)   sbpBank.style.display   = 'none';
    } else {
        if (numLbl)    numLbl.textContent    = 'Номер телефона';
        if (holderLbl) holderLbl.textContent = 'Имя получателя';
        if (inp) { inp.placeholder = '+7 900 000-00-00'; inp.maxLength = 18; inp.inputMode = 'tel'; }
        if (cardScene) cardScene.style.display = 'none';
        if (sbpScene)  sbpScene.style.display  = '';
        if (expiry)    expiry.style.display    = 'none';
        if (bankAuto)  bankAuto.style.display  = 'none';
        if (sbpBank)   sbpBank.style.display   = '';
    }
    if (inp) inp.value = '';
    const holderInp = document.getElementById('tr-holder');
    if (holderInp) holderInp.value = '';
    if (type === 'card') trUpdateCardPreview();
    else updateSbpPreview();
}

const _trCardTypeNames = { visa:'VISA', mastercard:'Mastercard', mir:'МИР', unionpay:'UnionPay' };

const _BANK_BINS = [
    { name:'Сбер',        bins:['4276','4279','4632','4645','5469','5484','5331','5332','2202','2204'] },
    { name:'Тинькофф',    bins:['5213','4377','5150','5375','5153','2200'] },
    { name:'ВТБ',         bins:['4272','4273','5162','4786','5285'] },
    { name:'Альфа',       bins:['4154','4274','5559','5321','5543'] },
    { name:'Газпром',     bins:['4267','5221','5540','4814'] },
    { name:'Озон',        bins:['4175','2203'] },
    { name:'Россельхоз',  bins:['4219','5275','4756'] },
    { name:'Райффайзен',  bins:['4222','5122','4123'] },
    { name:'МТС',         bins:['5268','4895'] },
    { name:'Почта',       bins:['4290','5124'] },
    { name:'РНКБ',        bins:['4442'] },
    { name:'Открытие',    bins:['4443','5191'] },
    { name:'Совком',      bins:['5578','5579'] },
];

function detectBank(digits) {
    if (!digits || digits.length < 4) return null;
    for (const bank of _BANK_BINS) {
        for (const bin of bank.bins) {
            if (digits.startsWith(bin)) return bank.name;
        }
    }
    return null;
}

let _trLastType = null;

function trUpdateCardPreview() {
    const numEl      = document.getElementById('tr-value');
    const holderEl   = document.getElementById('tr-holder');
    const numDisp    = document.getElementById('tr-mini-num');
    const holderDisp = document.getElementById('tr-mini-holder');
    const logoEl     = document.getElementById('tr-mini-logo');
    const badge      = document.getElementById('tr-card-type-badge');
    const cardEl     = document.getElementById('tr-card');
    if (!numDisp) return;

    const digits = (numEl?.value || '').replace(/\D/g,'').slice(0,16);
    let numStr = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) numStr += ' ';
        numStr += digits[i] || '•';
    }
    numDisp.textContent = numStr;

    const type = detectCardType(digits);
    const logos = { visa:'VISA', mastercard:'Mastercard', mir:'МИР', unionpay:'UnionPay' };
    if (logoEl) logoEl.textContent = type ? logos[type] : '';
    if (badge) {
        badge.className = 'tr-card-type-badge' + (type ? ' cd-' + type : '');
        badge.textContent = type ? _trCardTypeNames[type] : '';
    }

    holderDisp.textContent = (holderEl?.value || '').trim() || 'ВАШЕ ИМЯ';

    const expInp = document.getElementById('tr-expiry');
    const expDisp = document.getElementById('tr-mini-exp');
    if (expDisp) expDisp.textContent = (expInp?.value || '') || 'ММ/ГГ';

    // Цвет карты по типу (как в cp-card)
    if (cardEl) {
        _trLastType = type;
        cardEl.className = 'tr-card' + (type ? ' ' + type : '');
    }

    // Авто-определение банка по BIN
    const bankName = detectBank(digits);
    const bankInp  = document.getElementById('tr-bank');
    const bankWrap = document.getElementById('tr-bank-auto');
    const bankLabel = document.getElementById('tr-bank-auto-name');
    const bankBadge = document.getElementById('tr-bank-auto-badge');
    if (bankInp) bankInp.value = bankName || '';
    if (bankWrap) bankWrap.classList.toggle('detected', !!bankName);
    if (bankLabel) bankLabel.textContent = bankName || 'Не определён';
    if (bankBadge) bankBadge.style.display = bankName ? '' : 'none';
}

function fmtTrExpiry(inp) {
    let v = inp.value.replace(/\D/g,'').slice(0,4);
    if (v.length >= 3) v = v.slice(0,2) + '/' + v.slice(2);
    inp.value = v;
    const expEl = document.getElementById('tr-mini-exp');
    if (expEl) expEl.textContent = v || 'ММ/ГГ';
}

function fmtMethodNum(inp) {
    if (_trMethodType === 'card') {
        inp.value = inp.value.replace(/\D/g,'').slice(0,16).replace(/(.{4})/g,'$1 ').trim();
        trUpdateCardPreview();
    } else {
        let d = inp.value.replace(/\D/g,'');
        if (d.startsWith('8')) d = '7' + d.slice(1);
        if (!d.startsWith('7') && d.length > 0) d = '7' + d;
        d = d.slice(0,11);
        let out = '';
        if (d.length > 0)  out = '+' + d.slice(0,1);
        if (d.length > 1)  out += ' ' + d.slice(1,4);
        if (d.length > 4)  out += ' ' + d.slice(4,7);
        if (d.length > 7)  out += '-' + d.slice(7,9);
        if (d.length > 9)  out += '-' + d.slice(9,11);
        inp.value = out;
        updateSbpPreview();
    }
}

async function submitMethod(btn) {
    const val     = (document.getElementById('tr-value')?.value   || '').trim();
    const holder  = (document.getElementById('tr-holder')?.value  || '').trim();
    const bank    = _trMethodType === 'card'
        ? (document.getElementById('tr-bank')?.value     || '').trim()
        : (document.getElementById('tr-sbp-bank')?.value || '').trim();
    const msg     = document.getElementById('tr-form-msg');

    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Добавление...';
    btn.disabled = true;

    const data = await api('POST', '/api/trader/methods', {
        type: _trMethodType, value: val.replace(/\s/g,''),
        holder, bank, daily_limit: 1000000, monthly_limit: 15000000
    });

    btn.innerHTML = orig; btn.disabled = false;

    if (data.success) {
        if (msg) { msg.textContent = '✅ Реквизит добавлен!'; msg.className = 'tr-msg ok'; }
        document.getElementById('tr-value').value  = '';
        document.getElementById('tr-holder').value = '';
        setTimeout(() => closeAddMethod(), 1000);
        loadTraderMethods();
    } else {
        if (msg) { msg.textContent = data.error || 'Ошибка'; msg.className = 'tr-msg err'; }
    }
}

// ===== LOGOUT =====
function logout() {
    localStorage.removeItem('bt_token');
    localStorage.removeItem('bt_user');
    localStorage.removeItem(CACHE_KEY);
    window.location.replace('/');
}

// ===== INIT: кэш мгновенно → сервер в фоне =====
(function init() {
    try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached && cached.username && (Date.now() - (cached._ts || 0)) < 1_200_000) {
            applyData(cached); // рисуем данные из кэша мгновенно
        }
    } catch {}
    loadInit(); // свежие данные с сервера в фоне
})();