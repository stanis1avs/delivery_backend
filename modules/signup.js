const { User } = require("../models");

module.exports = class UserModule {

  static async findOrCreateUser(telegramData) {
    const { id, first_name, last_name, username, photo_url } = telegramData;
    let user = await User.findOne({ where: { telegram_id: id } });

    if (!user) {
      user = await User.create({
        telegram_id: id,
        first_name,
        last_name,
        username,
        photo_url,
      });
    }

    return user;
  }

}