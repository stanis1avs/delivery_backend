const DISPATCHER_ROOM = 'dispatchers';

class SocketBroadcast {
  constructor() {
    this.io = null;
  }

  init(ioInstance) {
    this.io = ioInstance;

    this.io.on('connection', (socket) => {
      socket.on('join-dispatchers', () => {
        socket.join(DISPATCHER_ROOM);
      });

      // Персональная комната курьера для адресной доставки его заказов (BUG-107)
      socket.on('join-courier', (courierId) => {
        if (courierId) socket.join(`courier:${courierId}`);
      });

      socket.on('disconnect', () => {
        socket.leave(DISPATCHER_ROOM);
      });
    });
  }

  /**
   * Новый/обновлённый заказ → всем диспетчерам.
   */
  broadcastOrderUpdate(orderData) {
    if (!this.io) return;
    this.io.to(DISPATCHER_ROOM).emit('new-order', orderData);
  }

  /**
   * Новый/принятый заказ → конкретному курьеру-исполнителю (BUG-107).
   * @param {string} courierId
   * @param {object} orderData
   */
  broadcastOrderToCourier(courierId, orderData) {
    if (!this.io || !courierId) return;
    this.io.to(`courier:${courierId}`).emit('new-order', orderData);
  }

  /**
   * Обновление геопозиции курьера → всем диспетчерам.
   * Вызывается из geoRouter при POST /api/geo/courier/location.
   *
   * @param {string} courierId
   * @param {number} lat
   * @param {number} lon
   * @param {string} [name] — отображаемое имя курьера (опционально)
   */
  broadcastCourierLocation(courierId, lat, lon, name) {
    if (!this.io) return;
    this.io.to(DISPATCHER_ROOM).emit('courier-location', { courierId, lat, lon, name });
  }
}

module.exports = new SocketBroadcast();
