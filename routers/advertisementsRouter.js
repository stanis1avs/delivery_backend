const express = require('express');
const router = express.Router();
const multer  = require('multer')
const upload = multer({ dest: 'uploads/' })

const AvertisementModule = require('../modules/advertisementModule')
const checkAuth = require('../auth/checkAuth')

router.post('/', checkAuth, upload.array('images'), async (req, res) => {
  const infoFromModule = await AvertisementModule.create(req.body, req.files, req.user)

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

router.delete('/:id', checkAuth, async (req, res) => {
  const infoFromModule = await AvertisementModule.remove(req.params.id, req.user._id)

  if (infoFromModule instanceof Error) {
    return res.status(500).json({data: infoFromModule.message, status: "error"})
  }

  if (infoFromModule && typeof infoFromModule === 'string') {
    return res.status(403).json({data: infoFromModule, status: "error"})
  }

  return res.status(200).json({status: "ok"})
})

router.get('/', async (req, res) => {
  const infoFromModule = await AvertisementModule.find()

  if (infoFromModule instanceof Error) {
    return res.status(500).json({data: infoFromModule.message, status: "error"})
  }

  if (infoFromModule && infoFromModule instanceof Object) {
    return res.status(200).json({data: infoFromModule, status: "ok"})
  }
})

router.get('/:id', async (req, res) => {
  const infoFromModule = await AvertisementModule.find(req.params.id)

  if (infoFromModule instanceof Error) {
    return res.status(500).json({data: infoFromModule.message, status: "error"})
  }

  if (infoFromModule && infoFromModule instanceof Object) {
    return res.status(200).json({data: infoFromModule, status: "ok"})
  }
})

module.exports = router;