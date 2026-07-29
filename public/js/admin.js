function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Экранирование перед вставкой в innerHTML — username/email/details приходят
// от пользователей и могли пройти регистрацию до ужесточения валидации
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

const ACTION_LABELS = {
    register:       { label: 'Регистрация',  cls: 'badge-yellow',  icon: 'fa-user-plus'    },
    login:          { label: 'Вход',         cls: 'badge-success', icon: 'fa-sign-in-alt'  },
    password_reset: { label: 'Смена пароля', cls: 'badge-orange',  icon: 'fa-key'          },
    ban:            { label: 'Бан',          cls: 'badge-danger',  icon: 'fa-ban'          },
    unban:          { label: 'Разбан',       cls: 'badge-success', icon: 'fa-check-circle' },
    deposit:        { label: 'Пополнение',   cls: 'badge-green',   icon: 'fa-plus'         },
    withdrawal:     { label: 'Вывод',        cls: 'badge-orange',  icon: 'fa-arrow-up'     },
    transfer:       { label: 'Перевод',      cls: 'badge-blue',    icon: 'fa-paper-plane'  },
};

const TX_LABELS = {
    deposit:    { label: 'Пополнение',   cls: 'badge-green',  icon: 'fa-plus'        },
    withdrawal: { label: 'Вывод',        cls: 'badge-orange', icon: 'fa-arrow-up'    },
    transfer:   { label: 'Перевод P2P',  cls: 'badge-blue',   icon: 'fa-paper-plane' },
};

let allUsers        = [];
let allLogs         = [];
let allTransactions = [];

// ===== HELPERS =====

function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function avatarColor(name) {
    const palette = [
        'linear-gradient(135deg,#7c3aed,#5b21b6)',
        'linear-gradient(135deg,#0ea5e9,#0369a1)',
        'linear-gradient(135deg,#10b981,#059669)',
        'linear-gradient(135deg,#f59e0b,#d97706)',
        'linear-gradient(135deg,#ef4444,#b91c1c)',
    ];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return palette[Math.abs(h) % palette.length];
}

function logBadge(action) {
    const a = ACTION_LABELS[action] || { label: action, cls: 'badge-yellow', icon: 'fa-circle' };
    return `<span class="badge ${a.cls}"><i class="fas ${a.icon}"></i> ${a.label}</span>`;
}

function statusBadge(status) {
    return status === 'success'
        ? `<span class="badge badge-success">Успех</span>`
        : `<span class="badge badge-danger">Ошибка</span>`;
}

function renderPassportBlock(u) {
    if (!u.passport_submitted_at)
        return `<div class="modal-passport"><span class="modal-passport-empty">Паспорт не подан</span></div>`;

    const status = u.verified
        ? `<span class="badge badge-success"><i class="fas fa-id-card"></i> Подтверждён</span>`
        : `<span class="badge badge-orange"><i class="fas fa-hourglass-half"></i> На проверке</span>`;

    return `<div class="modal-passport">
        <div class="modal-passport-row"><span>Статус</span><span>${status}</span></div>
        <div class="modal-passport-row"><span>ФИО</span><span>${escapeHtml(u.passport_full_name || '—')}</span></div>
        <div class="modal-passport-row"><span>Серия и номер</span><span>${escapeHtml(u.passport_number || '—')}</span></div>
        <div class="modal-passport-row"><span>Подан</span><span>${fmtDate(u.passport_submitted_at)}</span></div>
        ${!u.verified ? `
        <div class="modal-passport-actions">
            <button class="btn-action btn-unban" onclick="verifyUser(${u.id}, true); closeModal()"><i class="fas fa-check"></i> Одобрить</button>
            <button class="btn-action btn-ban" onclick="verifyUser(${u.id}, false); closeModal()"><i class="fas fa-times"></i> Отклонить</button>
        </div>` : ''}
    </div>`;
}

function kycBadge(u) {
    if (u.verified)                 return `<span class="badge badge-success" title="${escapeHtml(u.passport_full_name || '')} · ${escapeHtml(u.passport_number || '')}"><i class="fas fa-id-card"></i> Паспорт ✓</span>`;
    if (u.passport_submitted_at)    return `<span class="badge badge-orange" title="${escapeHtml(u.passport_full_name || '')} · ${escapeHtml(u.passport_number || '')}"><i class="fas fa-hourglass-half"></i> На проверке</span>`;
    return '';
}

// ===== RENDER =====

function renderUsers(users) {
    const tbody = document.getElementById('users-tbody');
    document.getElementById('users-count').textContent = users.length;

    if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><i class="fas fa-users"></i><p>Нет пользователей</p></div></td></tr>`;
        return;
    }

    const roleLabel = { trader: '🤝 Трейдер', casino: '🎰 Казино', admin: '⚙️ Админ' };
    tbody.innerHTML = users.map(u => {
        const initials = escapeHtml(u.username[0].toUpperCase());
        const banned   = u.banned;
        const role     = u.role || 'trader';
        return `
        <tr class="${banned ? 'row-banned' : ''}" onclick="openModal(${u.id})" style="cursor:pointer">
            <td>
                <div class="user-cell">
                    <div class="user-avatar" style="background:${avatarColor(u.username)}">${initials}</div>
                    <div>
                        <div class="user-name">${escapeHtml(u.username)}</div>
                        <div class="user-email">${escapeHtml(u.email)}</div>
                    </div>
                </div>
            </td>
            <td>
                <div style="display:flex;flex-direction:column;gap:4px">
                    ${banned
                        ? `<span class="badge badge-danger"><i class="fas fa-ban"></i> Бан</span>`
                        : `<span class="badge badge-success"><i class="fas fa-check"></i> Активен</span>`
                    }
                    <span class="badge badge-role badge-role-${role}">${roleLabel[role] || role}</span>
                    ${kycBadge(u)}
                </div>
            </td>
            <td onclick="event.stopPropagation()" style="white-space:nowrap">
                <div class="action-btns">
                    ${banned
                        ? `<button class="btn-action btn-unban" title="Разблокировать" onclick="unbanUser(${u.id})"><i class="fas fa-check-circle"></i> Разбан</button>`
                        : `<button class="btn-action btn-ban"   title="Заблокировать"  onclick="banUser(${u.id})"><i class="fas fa-ban"></i> Бан</button>`
                    }
                    ${u.passport_submitted_at && !u.verified ? `
                    <button class="btn-action btn-unban" title="Одобрить паспорт" onclick="verifyUser(${u.id}, true)"><i class="fas fa-id-card"></i> KYC ✓</button>
                    <button class="btn-action btn-ban" title="Отклонить паспорт" onclick="verifyUser(${u.id}, false)"><i class="fas fa-id-card"></i> KYC ✕</button>
                    ` : ''}
                    <select class="role-select" title="Сменить роль" onchange="changeRole(${u.id}, this.value)" onclick="event.stopPropagation()">
                        <option value="trader"  ${role==='trader' ?'selected':''}>🤝 Трейдер</option>
                        <option value="casino"  ${role==='casino' ?'selected':''}>🎰 Казино</option>
                        <option value="admin"   ${role==='admin'  ?'selected':''}>⚙️ Админ</option>
                    </select>
                    <button class="btn-action btn-delete" title="Удалить" onclick="confirmDelete(${u.id}, this)">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderLogs(logs) {
    const tbody = document.getElementById('logs-tbody');
    document.getElementById('logs-count').textContent = logs.length;

    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-list-alt"></i><p>Нет активности</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(l => `
        <tr>
            <td>${logBadge(l.action)}</td>
            <td class="cell-email col-hide-sm" title="${escapeHtml(l.email || '')}">${escapeHtml(l.email || '—')}</td>
            <td class="detail-cell col-hide-md" title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '—')}</td>
            <td>${statusBadge(l.status)}</td>
            <td class="cell-time">${fmtDate(l.created_at)}</td>
        </tr>
    `).join('');
}

// ===== TRANSACTIONS =====

function fmtAmt(v) {
    return '$' + parseFloat(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTransactions(txs) {
    const tbody = document.getElementById('txs-tbody');
    document.getElementById('txs-count').textContent = txs.length;

    if (!txs.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fas fa-exchange-alt"></i><p>Нет транзакций</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = txs.map(tx => {
        const cfg  = TX_LABELS[tx.type] || { label: tx.type, cls: 'badge-yellow', icon: 'fa-circle' };
        const from = tx.sender_username
            ? `<div class="user-name">${escapeHtml(tx.sender_username)}</div><div class="user-email">${escapeHtml(tx.sender_email || '')}</div>`
            : `<span class="text-muted">—</span>`;
        const to   = tx.receiver_username
            ? `<div class="user-name">${escapeHtml(tx.receiver_username)}</div><div class="user-email">${escapeHtml(tx.receiver_email || '')}</div>`
            : `<span class="text-muted">—</span>`;
        return `<tr>
            <td><span class="badge ${cfg.cls}"><i class="fas ${cfg.icon}"></i> ${cfg.label}</span></td>
            <td>${from}</td>
            <td class="col-hide-sm">${to}</td>
            <td class="tx-amount-cell">${fmtAmt(tx.amount)}</td>
            <td class="cell-time">${fmtDate(tx.created_at)}</td>
        </tr>`;
    }).join('');
}

function filterTxs() {
    const type = document.getElementById('txs-filter').value;
    const q    = document.getElementById('txs-search').value.toLowerCase();
    renderTransactions(allTransactions.filter(tx =>
        (!type || tx.type === type) &&
        (!q    || [tx.sender_username, tx.sender_email, tx.receiver_username, tx.receiver_email]
            .filter(Boolean).join(' ').toLowerCase().includes(q))
    ));
}

// ===== FILTERS =====

function filterUsers() {
    const q = document.getElementById('users-search').value.toLowerCase();
    renderUsers(q
        ? allUsers.filter(u => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
        : allUsers
    );
}

function filterLogs() {
    const action = document.getElementById('logs-filter').value;
    const q      = document.getElementById('logs-search').value.toLowerCase();
    renderLogs(allLogs.filter(l =>
        (!action || l.action === action) &&
        (!q      || (l.email || '').toLowerCase().includes(q))
    ));
}

// ===== ADMIN ACTIONS =====

async function banUser(id) {
    const res  = await adminFetch(`/api/admin/users/${id}/ban`, { method: 'POST' });
    const data = await res.json();
    if (data.success) loadData();
    else alert('Ошибка: ' + data.error);
}

async function unbanUser(id) {
    const res  = await adminFetch(`/api/admin/users/${id}/unban`, { method: 'POST' });
    const data = await res.json();
    if (data.success) loadData();
    else alert('Ошибка: ' + data.error);
}

async function verifyUser(id, verified) {
    const res  = await adminFetch(`/api/admin/users/${id}/verify`, { method: 'POST', body: JSON.stringify({ verified }) });
    const data = await res.json();
    if (data.success) loadData();
    else alert('Ошибка: ' + data.error);
}

async function changeRole(id, role) {
    const res  = await adminFetch(`/api/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    const data = await res.json();
    if (data.success) loadData();
    else alert('Ошибка: ' + data.error);
}

function confirmDelete(id, btn) {
    const row  = btn.closest('tr');
    const name = row?.querySelector('.user-name')?.textContent?.trim() || `#${id}`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:32px 28px;max-width:380px;width:90%;text-align:center;">
            <div style="width:52px;height:52px;border-radius:14px;background:rgba(239,68,68,.12);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--danger);margin:0 auto 16px;">
                <i class="fas fa-trash"></i>
            </div>
            <div style="font-size:17px;font-weight:800;color:var(--text);margin-bottom:8px;">Удалить пользователя?</div>
            <div style="font-size:13px;color:var(--muted);margin-bottom:24px;">
                <strong style="color:var(--text);">${name}</strong> будет удалён навсегда.<br>Все данные, транзакции и реквизиты — тоже.
            </div>
            <div style="display:flex;gap:10px;">
                <button id="del-cancel" style="flex:1;padding:12px;border-radius:11px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:14px;font-weight:700;cursor:pointer;">Отмена</button>
                <button id="del-confirm" style="flex:1;padding:12px;border-radius:11px;border:none;background:var(--danger);color:#fff;font-size:14px;font-weight:700;cursor:pointer;">Удалить</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#del-cancel').onclick  = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#del-confirm').onclick = async () => {
        overlay.remove();
        await deleteUser(id);
    };
}

async function deleteUser(id) {
    try {
        const res  = await adminFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) loadData();
        else alert('Ошибка: ' + (data.error || 'неизвестная ошибка'));
    } catch(e) {
        alert('Ошибка сети: ' + e.message);
    }
}

// ===== MODAL =====

function openModal(userId) {
    const user = allUsers.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('modal-avatar').textContent   = user.username[0].toUpperCase();
    document.getElementById('modal-avatar').style.background = avatarColor(user.username);
    document.getElementById('modal-username').textContent = user.username + (user.banned ? ' 🚫' : '');
    document.getElementById('modal-email').textContent    = user.email;

    document.getElementById('modal-passport').innerHTML = renderPassportBlock(user);

    const logs = allLogs.filter(l => l.user_id === userId);
    const tbody = document.getElementById('modal-tbody');

    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state" style="padding:24px"><i class="fas fa-history"></i><p>Нет активности</p></div></td></tr>`;
    } else {
        tbody.innerHTML = logs.map(l => `
            <tr>
                <td>${logBadge(l.action)}</td>
                <td>${statusBadge(l.status)}</td>
                <td class="text-muted">${l.ip || '—'}</td>
                <td class="text-muted">${fmtDate(l.created_at)}</td>
            </tr>
        `).join('');
    }

    document.getElementById('user-modal').classList.add('open');
}

function closeModal(e) {
    if (e && e.target !== document.getElementById('user-modal')) return;
    document.getElementById('user-modal').classList.remove('open');
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('user-modal').classList.remove('open');
});

// ===== ADMIN AUTH =====

let adminKey = sessionStorage.getItem('adminKey') || '';

function adminFetch(url, opts = {}) {
    return fetch(url, {
        ...opts,
        headers: { ...(opts.headers || {}), 'x-admin-key': adminKey, 'ngrok-skip-browser-warning': '1' },
    });
}

function showKeyPrompt() {
    const overlay = document.createElement('div');
    overlay.id = 'key-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.85);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:rgba(10,10,28,.99);border:1px solid rgba(255,215,0,.25);border-radius:20px;padding:40px 44px;max-width:420px;width:100%;text-align:center;">
            <div style="width:56px;height:56px;border-radius:14px;background:rgba(255,215,0,.12);display:flex;align-items:center;justify-content:center;font-size:22px;color:#FFD700;margin:0 auto 18px;">
                <i class="fas fa-lock"></i>
            </div>
            <div style="font-size:20px;font-weight:800;color:#e8eaf0;margin-bottom:8px;">Панель администратора</div>
            <div style="font-size:13px;color:#6b7590;margin-bottom:24px;">Введите ключ доступа для входа</div>
            <input id="key-input" type="password" placeholder="Ключ доступа..." autocomplete="off"
                style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#e8eaf0;font-size:14px;padding:12px 16px;border-radius:12px;outline:none;margin-bottom:16px;">
            <div id="key-error" style="color:#ff4757;font-size:12px;margin-bottom:12px;display:none;">Неверный ключ доступа</div>
            <button id="key-submit"
                style="width:100%;background:linear-gradient(135deg,#FFD700,#FFA500);color:#000;font-size:14px;font-weight:800;padding:13px;border:none;border-radius:12px;cursor:pointer;">
                Войти <i class="fas fa-arrow-right"></i>
            </button>
        </div>`;
    document.body.appendChild(overlay);

    const input  = overlay.querySelector('#key-input');
    const errEl  = overlay.querySelector('#key-error');
    const submit = overlay.querySelector('#key-submit');

    const tryLogin = async () => {
        const val = input.value.trim();
        if (!val) return;
        const res = await fetch('/api/admin/dashboard', { headers: { 'x-admin-key': val } });
        if (res.ok) {
            adminKey = val;
            sessionStorage.setItem('adminKey', val);
            overlay.remove();
            loadData();
        } else {
            errEl.style.display = 'block';
            input.style.borderColor = 'rgba(255,71,87,.5)';
            input.value = '';
            input.focus();
        }
    };

    submit.addEventListener('click', tryLogin);
    input.addEventListener('keydown', e => e.key === 'Enter' && tryLogin());
    setTimeout(() => input.focus(), 100);
}

// ===== TOAST =====
function showToast(msg, type = 'success') {
    const ok = type === 'success';
    const t  = document.createElement('div');
    t.style.cssText = [
        'position:fixed;bottom:24px;right:24px;z-index:9999',
        `background:${ok ? 'rgba(0,210,106,.13)' : 'rgba(255,71,87,.13)'}`,
        `border:1px solid ${ok ? 'rgba(0,210,106,.35)' : 'rgba(255,71,87,.35)'}`,
        `color:${ok ? '#00d26a' : '#ff4757'}`,
        'padding:10px 18px;border-radius:12px;font-size:13px;font-weight:600',
        'display:flex;align-items:center;gap:8px',
        'backdrop-filter:blur(12px)',
        'opacity:0;transform:translateY(8px)',
        'transition:opacity .25s,transform .25s',
        'pointer-events:none;white-space:nowrap',
    ].join(';');
    t.innerHTML = `<i class="fas ${ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>${msg}`;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(() => {
        t.style.opacity = '0'; t.style.transform = 'translateY(8px)';
        setTimeout(() => t.remove(), 300);
    }, 2500);
}

// ===== PROGRESS BAR =====
let progressBar = null;

function showProgress() {
    if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.style.cssText = 'position:fixed;top:0;left:0;height:3px;z-index:9999;background:linear-gradient(90deg,#FFD700,#FFA500);border-radius:0 2px 2px 0;transition:width .3s ease,opacity .3s ease;width:0;opacity:1;';
        document.body.appendChild(progressBar);
    }
    progressBar.style.opacity = '1';
    progressBar.style.width = '0';
    requestAnimationFrame(() => { progressBar.style.width = '70%'; });
}

function finishProgress(ok) {
    if (!progressBar) return;
    progressBar.style.background = ok
        ? 'linear-gradient(90deg,#00d26a,#00a854)'
        : 'linear-gradient(90deg,#ff4757,#c0392b)';
    progressBar.style.width = '100%';
    setTimeout(() => {
        progressBar.style.opacity = '0';
        setTimeout(() => { if (progressBar) { progressBar.width = '0'; } }, 300);
    }, 400);
}

// ===== LOAD =====

async function loadData(triggerBtn) {
    const btn  = triggerBtn || document.getElementById('refresh-btn');
    const icon = document.getElementById('refresh-icon');
    const txt  = document.getElementById('refresh-text');

    // Запускаем прогресс-бар и анимацию кнопки
    showProgress();
    if (btn)  {
        btn.disabled = true;
        btn.style.background  = 'rgba(255,215,0,0.12)';
        btn.style.borderColor = 'rgba(255,215,0,0.4)';
        btn.style.color       = '#FFD700';
        btn.style.cursor      = 'wait';
    }
    if (icon) { icon.classList.remove('fa-sync-alt'); icon.classList.add('fa-spinner', 'fa-spin'); }
    if (txt)  txt.textContent = ' Обновление...';

    // Пульсируем статы
    document.querySelectorAll('.stat-card').forEach(c => c.classList.add('refreshing'));

    const t0 = Date.now();

    try {
        const res = await adminFetch('/api/admin/dashboard');
        if (res.status === 403) {
            sessionStorage.removeItem('adminKey'); adminKey = '';
            showKeyPrompt(); return;
        }
        const data = await res.json();

        // Минимум 500ms чтобы анимация была видна
        const elapsed = Date.now() - t0;
        if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));

        allUsers        = data.users;
        allLogs         = data.logs;
        allTransactions = data.transactions || [];

        document.getElementById('stat-users').textContent  = data.users.length;
        document.getElementById('stat-logins').textContent = data.stats.successful_logins;
        document.getElementById('stat-failed').textContent = data.stats.failed_logins;
        document.getElementById('stat-resets').textContent = data.stats.password_resets;
        document.getElementById('stat-tx').textContent     = data.stats.total_tx || 0;
        document.getElementById('stat-volume').textContent =
            '$' + parseFloat(data.stats.total_volume || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

        filterUsers();
        filterLogs();
        filterTxs();

        document.getElementById('last-update').textContent =
            'Обновлено в ' + new Date().toLocaleTimeString('ru-RU');

        finishProgress(true);
        showToast('Данные обновлены');
    } catch {
        document.getElementById('last-update').textContent = '❌ Ошибка загрузки';
        finishProgress(false);
        showToast('Ошибка загрузки данных', 'error');
    } finally {
        document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('refreshing'));
        if (btn)  {
            btn.disabled = false;
            btn.style.background = btn.style.borderColor = btn.style.color = btn.style.cursor = '';
        }
        if (icon) { icon.classList.remove('fa-spinner', 'fa-spin'); icon.classList.add('fa-sync-alt'); }
        if (txt)  txt.textContent = ' Обновить';
    }
}

const dFilterUsers = debounce(filterUsers, 250);
const dFilterLogs  = debounce(filterLogs,  250);
const dFilterTxs   = debounce(filterTxs,   250);

function switchPanel(name) {
    document.querySelectorAll('.mob-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.panel === name));
    document.querySelectorAll('.table-card[data-panel]').forEach(c =>
        c.classList.toggle('panel-active', c.dataset.panel === name));
}

// Init first panel active
switchPanel('users');

if (adminKey) {
    loadData();
} else {
    showKeyPrompt();
}
setInterval(() => { if (adminKey) loadData(); }, 30_000);