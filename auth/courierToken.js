const crypto = require('crypto');

// Лёгкая stateless-аутентификация для гео/заказных эндпоинтов (BUG-110).
// Токен = HMAC(courierId) на серверном секрете. Выдаётся при Telegram-логине,
// фронтенд хранит его рядом с courierId и присылает в заголовке X-Courier-Token.
// Не зависит от Passport (см. BUG-121) — самодостаточно.

const SECRET = process.env.COOKIE_SECRET || 'defaultSecret';

function signCourierToken(courierId) {
  return crypto.createHmac('sha256', SECRET).update(String(courierId)).digest('hex');
}

function verifyCourierToken(courierId, token) {
  if (!courierId || !token) return false;
  const expected = signCourierToken(courierId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  // Сравнение за константное время; длины должны совпадать
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Express-middleware: требует валидный courier-токен.
 * courierId берётся из тела/query/заголовка, токен — из X-Courier-Token/тела.
 * При успехе кладёт проверенный id в req.courierId.
 */
function requireCourier(req, res, next) {
  const courierId =
    (req.body && req.body.courierId) ||
    (req.query && req.query.courierId) ||
    req.headers['x-courier-id'];
  const token = req.headers['x-courier-token'] || (req.body && req.body.token);

  if (!verifyCourierToken(courierId, token)) {
    return res.status(401).json({ error: 'Не авторизовано' });
  }

  req.courierId = String(courierId);
  next();
}

module.exports = { signCourierToken, verifyCourierToken, requireCourier };
