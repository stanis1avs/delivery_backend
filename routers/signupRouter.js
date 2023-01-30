const express = require('express');
const router = express.Router();

const UserModule = require('../modules/registrationModule')

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