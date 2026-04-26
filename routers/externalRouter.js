const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/telegram-callback', async (req, res) => {
    const { telegramUserId, firstName, lastName, username, photoUrl } = req.query;

    console.log("ExternalRouter", req.query)
  
    if (!telegramUserId) {
      return res.status(400).json({ status: 'error', message: 'Invalid Telegram data' });
    }
  
    const response = await axios.post(`${process.env.BACKEND_URL}/api/signup/telegram-login`, {
      telegramUserId, firstName, lastName, username, photoUrl
    });
  
    if (response.data.status === 'ok') {
      return res.redirect('/profile');
    }
  
    return res.status(500).json({ status: 'error', message: 'Telegram login failed' });
  });


  module.exports = router;