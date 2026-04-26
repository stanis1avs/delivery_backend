const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const UserModule = require('../modules/signup');
const CourierModule = require('../modules/couriers');
const RedisModule = require('../modules/redis');

function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;

  if (!hash) return false;

  // Подпись действительна 24 часа
  const authDate = parseInt(rest.auth_date, 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return false;

  const checkString = Object.keys(rest)
    .filter((k) => rest[k] !== undefined && rest[k] !== null)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');

  const secretKey = crypto
    .createHash('sha256')
    .update(process.env.TELEGRAM_BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  return expectedHash === hash;
}

router.get('/telegram-login', async (req, res) => {
  if (!verifyTelegramAuth(req.query)) {
    return res.status(403).json({ status: 'error', message: 'Invalid Telegram signature' });
  }

  const { id, first_name, last_name, username, photo_url } = req.query;

  try {
    const user = await UserModule.findOrCreateUser({ id, first_name, last_name, username, photo_url });

    const courier = await CourierModule.findOrCreateCourier(user.dataValues.id);

    const statusData = { last_online_at: new Date() };
    await CourierModule.updateCourierStatus(courier.dataValues.id, statusData);

    await RedisModule.updateCourierStatus(courier.dataValues.id, {
      is_online: 'true',
      has_order: 'false',
      last_online_at: new Date().toISOString(),
      telegramId: String(user.dataValues.telegram_id),
    });

    const encodedUser = encodeURIComponent(JSON.stringify(user.dataValues));

    return res.redirect(`${process.env.CLIENT_URL}?user=${encodedUser}`);
  } catch (err) {
    console.error('Ошибка авторизации через Telegram:', err);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
