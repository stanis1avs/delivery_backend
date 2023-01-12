const UserModule = require('../basicModules/users')
const passport = require("passport");

module.exports = async function (app)  {
  console.log('Connect auth')
  app.post('/api/signin', (req, res) => {
    passport.authenticate('local', (err, user) => {
      if (err) {
        return res.send(new Error(err));
      }
      if (!user) {
        return res.send(JSON.stringify({error: "Неверный логин или пароль", status: "error"}));
      }
      req.logIn(user, (err) => {
        if (err) {
          return res.send(new Error(err));
        }
        res.send(JSON.stringify({data: user, status: "ok"}));
      });
    })(req, res);
  })
};