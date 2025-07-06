const express = require('express');
const router = express.Router();
const UserModule = require('../modules/signup');
const CourierModule = require('../modules/couriers');
const RedisModule = require('../modules/redis');

router.get('/telegram-login', async (req, res) => {
  const { id, first_name, last_name, username, photo_url } = req.query;

  try {
    const user = await UserModule.findOrCreateUser({ id, first_name, last_name, username, photo_url });

    console.log(user.dataValues.id)

    const courier = await CourierModule.findOrCreateCourier(user.dataValues.id);

    const statusData = {
      last_online_at: new Date(),
    };
    await CourierModule.updateCourierStatus(courier.dataValues.id, statusData);

    console.log({statusData})

    console.log(user.dataValues)

    await RedisModule.updateCourierStatus(courier.dataValues.id, {
      is_online: true,
      has_order: false,
      last_online_at: new Date(),
      telegramId: user.dataValues.telegram_id
    });

    const encodedUser = encodeURIComponent(JSON.stringify(user));

    return res.redirect(`${process.env.CLIENT_URL}?user=${encodedUser}`);
  } catch (err) {
    return res.status(500).send('Server error');
  }
});

module.exports = router;
