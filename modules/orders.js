const { Order } = require('../models');

module.exports = class OrderModule {
  static async findById(orderId) {

    console.log('Finding order:', orderId);
    try {
      let courier = await Order.findByPk(orderId);

      return courier;
    } catch (error) {
    console.error('Error in findOrder:', error);
    throw error;
  }
  }
}
