const express = require('express');
const router = express.Router();

const UserModule = require('../modules/registrationModule')

router.get('/telegram-login', async (req, res) => {
  const { id, first_name, last_name, username, photo_url } = req.query;

  try {
    const user = await UserModule.findByTelegramId(id);

    const userData = user || await UserModule.createFromTelegram({
      id, first_name, last_name, username, photo_url
    });

    const encodedUser = encodeURIComponent(JSON.stringify(userData));

    return res.redirect(`https://eeda-198-98-50-3.ngrok-free.app?user=${encodedUser}`);
  } catch (err) {
    return res.status(500).send('Ошибка авторизации');
  }
});

router.post('/', async (req, res) => {
  const infoFromModule = await UserModule.create(req.body)

  if (infoFromModule instanceof Error) {
    return res.status(500).json({data: infoFromModule.message, status: "error"})
  }

  if (infoFromModule && typeof infoFromModule === 'string') {
    return res.status(400).json({data: infoFromModule, status: "error"})
  }

  if (infoFromModule && infoFromModule instanceof Object) {
    return res.status(200).json({data: infoFromModule, status: "ok"})
  }
})

module.exports = router;
