const CryptoJS = require("crypto-js");
const { User } = require("../models");

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

  static async createFromTelegram({ id, first_name, last_name, username, photo_url }) {
    try {
      const user = await User.create({
        telegram_id: id,
        first_name,
        last_name,
        username,
        photo_url,
      });
      return user;
    } catch (e) {
      throw new Error('Failed to create user: ' + e.message);
    }
  }

  static async findByTelegramId(telegramUserId) {
    try {
      const user = await User.findOne({ where: { telegram_id: telegramUserId } });
      return user || null;
    } catch (e) {
      throw new Error('Failed to find user: ' + e.message);
    }
  }

}