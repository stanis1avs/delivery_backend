const express = require('express');
const router = express.Router();

const {passport} = require('../auth/passportAuthentication');

router.post('/', (req, res) => {
  if (req.body.password && req.body.email) {
    passport.authenticate('local', (err, user) => {
      if (err) {
        return res.status(500).json({error: "error authenticate", status: "error"})
      }
      if (!user) {
        return res.status(400).json({error: "invalid login or password", status: "error"});
      }
      req.logIn(user, (err) => {
        if (err) {
          return res.status(500).json({error: "error authenticate", status: "error"})
        }
        return res.status(200).json({data: user, status: "ok"});
      });
    })(req, res);
  }
  else {
    return res.status(400).json({error: "invalid data", status: "error"});
  }
})

module.exports = router;