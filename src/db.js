const { Pool } = require('pg');

// Transaction mode (port 6543): создан для pooler'ов вроде Node.js, лимит выше
const txUrl = (process.env.DATABASE_URL || '').replace(':5432/', ':6543/');
const pool = new Pool({
    connectionString: txUrl,
    ssl: { rejectUnauthorized: false },
    max: 3,   // 3 × 8 воркеров = 24 соединения — в пределах лимита
    min: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true,
});

pool.on('error', err => console.error('DB pool error:', err.message));

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            username      VARCHAR(50)  NOT NULL,
            email         VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT         NOT NULL,
            created_at    TIMESTAMPTZ  DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS activity_logs (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            email       VARCHAR(255),
            action      VARCHAR(50)  NOT NULL,
            status      VARCHAR(20)  DEFAULT 'success',
            ip          VARCHAR(45),
            details     TEXT,
            created_at  TIMESTAMPTZ  DEFAULT NOW()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned    BOOLEAN     DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ DEFAULT NULL;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role      VARCHAR(20)  DEFAULT 'trader';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS verified  BOOLEAN      DEFAULT false;
        -- KYC: фото/скан паспорта трейдера, обязательны для управления реквизитами
        ALTER TABLE users DROP COLUMN IF EXISTS passport_full_name;
        ALTER TABLE users DROP COLUMN IF EXISTS passport_number;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_submitted_at TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_image        BYTEA;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_image_mime   VARCHAR(30);
        CREATE TABLE IF NOT EXISTS wallets (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            balance    NUMERIC(15,2) DEFAULT 0.00,
            currency   VARCHAR(3)    DEFAULT 'USD',
            updated_at TIMESTAMPTZ   DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS transactions (
            id          SERIAL PRIMARY KEY,
            sender_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            amount      NUMERIC(15,2) NOT NULL,
            type        VARCHAR(20)   NOT NULL,
            status      VARCHAR(20)   DEFAULT 'completed',
            description TEXT,
            created_at  TIMESTAMPTZ   DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
            jti         VARCHAR(64) UNIQUE NOT NULL,
            ip          VARCHAR(45),
            device_type VARCHAR(20)  DEFAULT 'desktop',
            device_name VARCHAR(150) DEFAULT 'Неизвестно',
            country     VARCHAR(100),
            city        VARCHAR(100),
            flag        VARCHAR(10)  DEFAULT '🌍',
            created_at  TIMESTAMPTZ  DEFAULT NOW(),
            last_seen   TIMESTAMPTZ  DEFAULT NOW(),
            is_active   BOOLEAN      DEFAULT true
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_sessions_jti  ON sessions(jti) WHERE is_active = true;

        -- Users lookup indexes (критично: каждый login/transfer делает full scan без них)
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
        CREATE INDEX        IF NOT EXISTS idx_users_username ON users(LOWER(username));
        CREATE INDEX        IF NOT EXISTS idx_users_banned   ON users(id) WHERE banned = false;

        -- Performance indexes
        CREATE INDEX IF NOT EXISTS idx_logs_email      ON activity_logs(email);
        CREATE INDEX IF NOT EXISTS idx_logs_user_id    ON activity_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_logs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_logs_action     ON activity_logs(action, status);
        CREATE INDEX IF NOT EXISTS idx_tx_sender       ON transactions(sender_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_receiver     ON transactions(receiver_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_created_at   ON transactions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_type         ON transactions(type);

        CREATE TABLE IF NOT EXISTS email_change_otps (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            new_email  TEXT NOT NULL,
            code       TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS trader_methods (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
            type          VARCHAR(10)   NOT NULL DEFAULT 'card',
            value         TEXT          NOT NULL,
            holder        TEXT,
            bank          TEXT,
            is_active     BOOLEAN       DEFAULT true,
            priority      INTEGER       DEFAULT 0,
            daily_limit   NUMERIC(15,2) DEFAULT 1000000,
            monthly_limit NUMERIC(15,2) DEFAULT 15000000,
            daily_used    NUMERIC(15,2) DEFAULT 0,
            monthly_used  NUMERIC(15,2) DEFAULT 0,
            created_at    TIMESTAMPTZ   DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_trader_methods_user ON trader_methods(user_id);
        -- Даты последнего сброса daily_used/monthly_used (для авто-ротации по лимиту)
        ALTER TABLE trader_methods ADD COLUMN IF NOT EXISTS daily_reset_at   DATE DEFAULT CURRENT_DATE;
        ALTER TABLE trader_methods ADD COLUMN IF NOT EXISTS monthly_reset_at DATE DEFAULT CURRENT_DATE;
    `);
}

// Single-query log — fire-and-forget (не блокирует ответ)
function logActivity(email, action, status, ip, details = '') {
    pool.query(
        `INSERT INTO activity_logs (user_id, email, action, status, ip, details)
         VALUES ((SELECT id FROM users WHERE email = $1 LIMIT 1), $1, $2, $3, $4, $5)`,
        [email, action, status, ip || '', details]
    ).catch(err => console.error('Лог:', err.message));
}

module.exports = { pool, initDB, logActivity };
