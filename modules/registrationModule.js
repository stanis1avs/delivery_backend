const CryptoJS = require("crypto-js");
const User = require('../models/userSchema')

module.exports = class UserModule {
  static async create(data) {
    let {email, password, name, contactPhone} = data;

    if (email && password && name) {
      const infoFromPossibleUser = await UserModule.findByEmail(email)

      if (infoFromPossibleUser instanceof Error) {
        return infoFromPossibleUser
      }

      if (infoFromPossibleUser instanceof Object) {
        password = CryptoJS.SHA256(password).toString();

        try {
          const user = new User({email, password, name, contactPhone})

          const {_id, email, name, contactPhone} = await user.save()

          return {_id, email, name, contactPhone}

        } catch(e) {

          return new Error(e)
        }

      }

      return "email busy"

    }

    else {
      return "invalid data"
    }
  }

  static async findByEmail(email) {
    try {
      const user = await User.find({email: email})

      if (user.length === 0) {

        return user
      }

      return null
    } catch (e) {

      return new Error(e)
    }
  }


}