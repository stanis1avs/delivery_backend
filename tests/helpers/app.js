// Минимальное приложение для API-тестов: те же роутеры, что в index.js, но без
// Telegram-бота, сокетов и слушающего порта. Так тест не поднимает лишнего и не
// конфликтует с работающим приложением.

const express = require('express');
const crypto = require('crypto');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/geo', require('../../routers/geoRouter'));
  app.use('/api/orders', require('../../routers/ordersRouter'));
  return app;
}

/** Токен курьера — тот же HMAC, что выдаёт signup.js при логине. */
function courierToken(courierId) {
  return crypto
    .createHmac('sha256', process.env.COOKIE_SECRET || 'defaultSecret')
    .update(String(courierId))
    .digest('hex');
}

/** Заголовки авторизованного курьера. */
function authHeaders(courierId) {
  return {
    'X-Courier-Token': courierToken(courierId),
    'X-Courier-Id': String(courierId),
  };
}

module.exports = { buildApp, courierToken, authHeaders };
