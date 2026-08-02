const { Order } = require('../models');
const { toLatLon } = require('./geo');

module.exports = class OrderModule {
  static async findById(orderId) {
    try {
      return await Order.findByPk(orderId);
    } catch (error) {
      console.error('Error in findOrder:', error);
      throw error;
    }
  }

  /**
   * Привести заказ к форме, которую ждёт фронтенд.
   *
   * Один сериализатор на оба канала доставки — REST (`GET /api/orders/active`)
   * и WebSocket (`new-order`), чтобы карточки не зависели от того, откуда пришёл заказ.
   *
   * @param {object} order — модель Order
   * @param {object} [courier] — модель Courier исполнителя, для блока с транспортом
   */
  static serializeForClient(order, courier = null) {
    return {
      id: order.id,
      status: order.status,
      // details оставлен для обратной совместимости с существующими карточками
      details: order.customer_name || 'Заказ',
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      pickup_location: toLatLon(order.pickup_location),
      dropoff_location: toLatLon(order.dropoff_location),
      pickup_address: order.pickup_address,
      dropoff_address: order.dropoff_address,
      distance_meters: order.distance_meters,
      estimated_duration_seconds: order.estimated_duration_seconds,
      total_price: order.total_price,
      // Момент последней смены статуса — от него фронтенд считает время прибытия
      status_changed_at: order.updated_at,
      vehicle: courier
        ? {
            model: courier.vehicle_model,
            plate: courier.license_plate,
            payload_kg: courier.payload_kg,
            volume_m3: courier.volume_m3,
          }
        : null,
    };
  }
};
