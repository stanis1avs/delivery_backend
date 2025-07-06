const { Courier, User, CourierStatus } = require('../models');

module.exports = class CourierModule {
  static async findOrCreateCourier(userId) {

    console.log('Finding or creating courier for user:', userId);
    try {
      let courier = await Courier.findOne({ where: { user_id: userId } });

      if (!courier) {
        courier = await Courier.create({
          user_id: userId,
        });
      }

      return courier;
    } catch (error) {
      console.error('Error in findOrCreateCourier:', error);
      throw error;
    }
  }

  static async findByTelegramId(courier_telegram_id) {

    console.log('Finding courier for id:', courier_telegram_id);
    try {
      const courier = await Courier.findOne({
        include: [
          {
            model: User,
            where: { telegram_id: courier_telegram_id },
          },
        ],
      });

      return courier;
    } catch (error) {
      console.error('Error in Finding Courier:', error);
      throw error;
    }
  }

  static async updateCourierStatus(courierId, statusData) {
    try {
      let courierStatus = await CourierStatus.findOne({ where: { courier_id: courierId } });

      if (!courierStatus) {
        courierStatus = await CourierStatus.create({
          courier_id: courierId,
          ...statusData,
        });
      } else {
        Object.assign(courierStatus, statusData);
        await courierStatus.save();
      }

      return courierStatus;

    } catch (error) {
      console.error('Error in findOrCreateCourier:', error);
      throw error;
    }
  }
}
