const nodemailer = require('nodemailer');
const path = require('path');
const fs   = require('fs');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

const otpTemplate = fs.readFileSync(path.join(__dirname, 'emails', 'otp.html'), 'utf8');

function sendOtpEmail(email, code) {
    return transporter.sendMail({
        from:    '"Banana Transaction" <magometmaga0@gmail.com>',
        to:      email,
        subject: '🔐 Ваш код подтверждения — Banana Transaction',
        html:    otpTemplate.replace('{{CODE}}', code),
        text:    `Код подтверждения: ${code}\n\nДействителен 2 минуты.\n\n© 2026 Banana Transaction.`,
    });
}

module.exports = { sendOtpEmail };
