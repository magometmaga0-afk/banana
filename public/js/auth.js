// ===== УТИЛИТЫ =====

async function apiFetch(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': '1',
        },
        body: JSON.stringify(body),
    });
    return res.json();
}

function withLoading(btn, text, action) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${text}`;
    return action().finally(() => {
        btn.disabled = false;
        btn.innerHTML = original;
    });
}

function showMessage(type, form, text) {
    const el = document.getElementById(`${form}-${type}`);
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function clearMessages() {
    document.querySelectorAll('.error-message, .success-message').forEach(el => {
        el.style.display = 'none';
        el.textContent = '';
    });
}

function bindStrengthBar(inputEl, barEl) {
    inputEl.addEventListener('input', function () {
        const v = this.value;
        let s = 0;
        if (v.length >= 8) s += 25;
        if (/[A-Z]/.test(v)) s += 25;
        if (/[a-z]/.test(v)) s += 25;
        if (/[0-9]/.test(v)) s += 25;
        barEl.style.width = s + '%';
        barEl.className = 'strength-bar ' + (s < 40 ? 'strength-weak' : s < 80 ? 'strength-medium' : 'strength-strong');
    });
}

function bindPasswordMatch(pwdEl, confirmEl, matchEl) {
    confirmEl.addEventListener('input', function () {
        if (!this.value) { matchEl.textContent = ''; return; }
        const ok = pwdEl.value === this.value;
        matchEl.textContent = ok ? '✅ Пароли совпадают' : '❌ Пароли не совпадают';
        matchEl.style.color = ok ? 'var(--success)' : 'var(--danger)';
    });
}

function startCountdown(seconds, timerEl) {
    let left = seconds;
    const id = setInterval(() => {
        left--;
        if (left <= 0) {
            clearInterval(id);
            timerEl.textContent = '⏰ Код истёк. Отправьте заново.';
            timerEl.style.color = 'var(--danger)';
        } else {
            const m = Math.floor(left / 60), s = left % 60;
            timerEl.textContent = `⏳ Действителен: ${m}:${s.toString().padStart(2, '0')}`;
            timerEl.style.color = 'var(--text-secondary)';
        }
    }, 1000);
    return id;
}

// ===== ТАБЫ =====
function switchTab(tabId) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.querySelector(`.auth-tab[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(`${tabId}-form`).classList.add('active');
    clearMessages();
}

document.querySelectorAll('.auth-tab').forEach(tab =>
    tab.addEventListener('click', function () { switchTab(this.dataset.tab); })
);

// ===== ВХОД =====
document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) return showMessage('error', 'login', '❌ Заполните все поля');

    withLoading(this.querySelector('[type="submit"]'), 'Вход...', async () => {
        try {
            const data = await apiFetch('/api/auth/login', { email, password });
            if (data.success) {
                localStorage.setItem('bt_token', data.token);
                localStorage.setItem('bt_user', data.username);
                showMessage('success', 'login', `✅ Добро пожаловать, ${data.username}!`);
                setTimeout(() => window.location.replace('/dashboard.html'), 800);
            } else {
                showMessage('error', 'login', '❌ ' + (data.error || 'Ошибка входа'));
            }
        } catch {
            showMessage('error', 'login', '❌ Сервер не отвечает');
        }
    });
});

// ===== РЕГИСТРАЦИЯ =====
bindStrengthBar(
    document.getElementById('register-password'),
    document.getElementById('password-strength-bar')
);
bindPasswordMatch(
    document.getElementById('register-password'),
    document.getElementById('register-confirm'),
    document.getElementById('password-match')
);

let _regStep = 1;
let _regEmail = '';
let _regTimer = null;
let _regTicket = '';

function _setRegStep(step) {
    _regStep = step;
    const otpSection = document.getElementById('register-otp-section');
    const btn        = document.getElementById('register-btn');
    const fields     = ['register-username','register-email','register-password','register-confirm'];
    if (step === 2) {
        otpSection.style.display = 'block';
        btn.innerHTML = 'Создать аккаунт <i class="fas fa-user-plus"></i>';
        fields.forEach(id => { document.getElementById(id).disabled = true; });
        document.getElementById('register-code').focus();
    } else {
        otpSection.style.display = 'none';
        btn.innerHTML = 'Продолжить <i class="fas fa-arrow-right"></i>';
        fields.forEach(id => { document.getElementById(id).disabled = false; });
        if (_regTimer) clearInterval(_regTimer);
    }
}

function resendRegOtp(e) {
    e.preventDefault();
    if (_regTimer) clearInterval(_regTimer);
    document.getElementById('register-code').value = '';
    document.getElementById('register-resend-link').style.display = 'none';
    apiFetch('/api/auth/send-otp', { email: _regEmail }).then(data => {
        if (data.success) {
            showMessage('success', 'register', '✅ Код отправлен повторно');
            _regTimer = startCountdown(120, document.getElementById('register-otp-timer'));
            setTimeout(() => { document.getElementById('register-resend-link').style.display = 'block'; }, 120000);
        } else {
            showMessage('error', 'register', '❌ ' + (data.error || 'Ошибка'));
        }
    });
}

document.getElementById('register-form').addEventListener('submit', function (e) {
    e.preventDefault();

    if (_regStep === 1) {
        const username = document.getElementById('register-username').value.trim();
        const email    = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const confirm  = document.getElementById('register-confirm').value;

        if (!username || !email || !password || !confirm) return showMessage('error', 'register', '❌ Заполните все поля');
        if (password.length < 8) return showMessage('error', 'register', '❌ Пароль минимум 8 символов');
        if (password !== confirm) return showMessage('error', 'register', '❌ Пароли не совпадают');

        withLoading(document.getElementById('register-btn'), 'Отправка кода...', async () => {
            try {
                const data = await apiFetch('/api/auth/send-otp', { email });
                if (data.success) {
                    _regEmail = email;
                    _setRegStep(2);
                    showMessage('success', 'register', `✅ Код отправлен на ${email}`);
                    _regTimer = startCountdown(120, document.getElementById('register-otp-timer'));
                    setTimeout(() => { document.getElementById('register-resend-link').style.display = 'block'; }, 120000);
                } else {
                    showMessage('error', 'register', '❌ ' + (data.error || 'Ошибка отправки'));
                }
            } catch {
                showMessage('error', 'register', '❌ Сервер не отвечает');
            }
        });
        return;
    }

    // Step 2: verify OTP then register
    const code     = document.getElementById('register-code').value.trim();
    const username = document.getElementById('register-username').value.trim();
    const email    = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;

    if (!code || code.length !== 6) return showMessage('error', 'register', '❌ Введите 6-значный код');

    withLoading(document.getElementById('register-btn'), 'Создание...', async () => {
        try {
            const verify = await apiFetch('/api/auth/verify-otp', { email, code });
            if (!verify.success) {
                showMessage('error', 'register', '❌ ' + (verify.error || 'Неверный код'));
                return;
            }
            _regTicket = verify.ticket || '';
            const reg = await apiFetch('/api/auth/register', { username, email, password, ticket: _regTicket });
            if (reg.success) {
                showMessage('success', 'register', '✅ Аккаунт создан!');
                _setRegStep(1);
                ['register-username','register-email','register-password','register-confirm','register-code']
                    .forEach(id => { document.getElementById(id).value = ''; });
                document.getElementById('password-match').textContent = '';
                document.getElementById('password-strength-bar').style.width = '0%';
                setTimeout(() => {
                    switchTab('login');
                    document.getElementById('login-email').value = email;
                    showMessage('success', 'login', '✅ Войдите с вашими данными');
                }, 1500);
            } else {
                showMessage('error', 'register', '❌ ' + (reg.error || 'Ошибка регистрации'));
            }
        } catch {
            showMessage('error', 'register', '❌ Сервер не отвечает');
        }
    });
});

// ===== ВОССТАНОВЛЕНИЕ ПАРОЛЯ =====
let forgotTimer = null;
let forgotEmail = '';
let forgotTicket = '';

function showForgot() {
    document.querySelector('.auth-tabs').style.display = 'none';
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('forgot-form').classList.add('active');
    clearMessages();
    setForgotStep(1);
}

function hideForgot() {
    if (forgotTimer) clearInterval(forgotTimer);
    document.querySelector('.auth-tabs').style.display = 'flex';
    switchTab('login');
    ['forgot-email','forgot-code','forgot-new-password','forgot-confirm-password']
        .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('forgot-password-match').textContent = '';
    document.getElementById('forgot-strength-bar').style.width = '0%';
    setForgotStep(1);
}

function setForgotStep(step) {
    document.querySelectorAll('.forgot-step').forEach(s => s.classList.remove('active'));
    document.getElementById('forgot-step-' + step).classList.add('active');
    document.querySelectorAll('.step-dot').forEach((dot, i) => {
        dot.classList.remove('active', 'done');
        if (i + 1 < step)      dot.classList.add('done');
        else if (i + 1 === step) dot.classList.add('active');
    });
    document.querySelectorAll('.step-line').forEach((line, i) => {
        line.classList.toggle('done', i + 1 < step);
    });
}

bindStrengthBar(
    document.getElementById('forgot-new-password'),
    document.getElementById('forgot-strength-bar')
);
bindPasswordMatch(
    document.getElementById('forgot-new-password'),
    document.getElementById('forgot-confirm-password'),
    document.getElementById('forgot-password-match')
);

document.getElementById('forgot-send-btn').addEventListener('click', function () {
    const email = document.getElementById('forgot-email').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return showMessage('error', 'forgot', '❌ Введите корректный email');

    withLoading(this, 'Отправка...', async () => {
        try {
            const data = await apiFetch('/api/auth/send-otp', { email });
            if (data.success) {
                forgotEmail = email;
                document.getElementById('forgot-email-display').textContent = email;
                setForgotStep(2);
                if (forgotTimer) clearInterval(forgotTimer);
                forgotTimer = startCountdown(120, document.getElementById('forgot-timer'));
            } else {
                showMessage('error', 'forgot', '❌ ' + (data.error || 'Ошибка'));
            }
        } catch {
            showMessage('error', 'forgot', '❌ Сервер не отвечает');
        }
    });
});

document.getElementById('forgot-verify-btn').addEventListener('click', function () {
    const code = document.getElementById('forgot-code').value.trim();
    if (!code || code.length !== 6) return showMessage('error', 'forgot', '❌ Введите 6-значный код');

    withLoading(this, 'Проверка...', async () => {
        try {
            const data = await apiFetch('/api/auth/verify-otp', { email: forgotEmail, code });
            if (data.success) {
                forgotTicket = data.ticket || '';
                if (forgotTimer) clearInterval(forgotTimer);
                setForgotStep(3);
            } else {
                showMessage('error', 'forgot', '❌ ' + (data.error || 'Неверный код'));
            }
        } catch {
            showMessage('error', 'forgot', '❌ Сервер не отвечает');
        }
    });
});

document.getElementById('forgot-reset-btn').addEventListener('click', function () {
    const password = document.getElementById('forgot-new-password').value;
    const confirm  = document.getElementById('forgot-confirm-password').value;
    if (!password || password.length < 8) return showMessage('error', 'forgot', '❌ Пароль минимум 8 символов');
    if (password !== confirm)             return showMessage('error', 'forgot', '❌ Пароли не совпадают');

    withLoading(this, 'Сохранение...', async () => {
        try {
            const data = await apiFetch('/api/auth/reset-password', { email: forgotEmail, password, ticket: forgotTicket });
            if (data.success) setForgotStep(4);
            else showMessage('error', 'forgot', '❌ ' + (data.error || 'Ошибка сервера'));
        } catch {
            showMessage('error', 'forgot', '❌ Сервер не отвечает');
        }
    });
});

document.getElementById('forgot-resend-link').addEventListener('click', function (e) {
    e.preventDefault();
    if (forgotTimer) clearInterval(forgotTimer);
    document.getElementById('forgot-code').value = '';
    apiFetch('/api/auth/send-otp', { email: forgotEmail }).then(data => {
        if (data.success) {
            showMessage('success', 'forgot', '✅ Код отправлен повторно');
            forgotTimer = startCountdown(120, document.getElementById('forgot-timer'));
        }
    });
});
