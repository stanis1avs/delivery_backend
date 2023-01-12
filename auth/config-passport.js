const LocalStrategy = require('passport-local').Strategy;
const CryptoJS = require('crypto-js');
const UserModule = require('./basicModules/users')

module.exports = function (passport, db){
  console.log('config')
  const collectionUsers = db.collection('users');
  const userMod = new UserModule(collectionUsers)

  passport.serializeUser( (data, done) => {
    done(null, data);
  });

  passport.deserializeUser( async (dataSession, done) => {
    const bySearchEmail = await userMod.findByEmail(dataSession.email)
    const user = bySearchEmail._id == dataSession.id ? dataSession : false;
    done(null, user);
  });

  passport.use(
    new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
      const cryptoPassword = CryptoJS.SHA256(password).toString();
      const emailExists = await userMod.findByEmail(email)
      if (emailExists && emailExists.password === cryptoPassword) {
        const data = {
          id: emailExists._id,
          email: emailExists.email,
          name: emailExists.name,
          contactPhone: emailExists.contactPhone
        }
        return done(null, data);
      } else {
        return done(null, false);
      }
    })
  );
}