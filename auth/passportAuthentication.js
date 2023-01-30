const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const CryptoJS = require('crypto-js');
const User = require('../models/userSchema')

passport.serializeUser( (data, done) => {
  done(null, data._id);
});

passport.deserializeUser( async (id, done) => {
  const user = await User.findById(id)
  done(null, user);
});

passport.use('local', 
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    const cryptoPassword = CryptoJS.SHA256(password).toString();

    const emailExists = await User.findOne({email: email})

    if (emailExists && emailExists.password === cryptoPassword) {
      const {_id, email, name, contactPhone} = emailExists
      return done(null, {email, name, contactPhone, _id});
    } else {
      return done(null, false);
    }
  })
);

module.exports = {passport};