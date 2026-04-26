const DISPATCHER_ROOM = 'dispatchers';

class SocketBroadcast {
  constructor() {
    this.io = null;
  }

  init(ioInstance) {
    this.io = ioInstance;

    this.io.on('connection', (socket) => {
      // Клиент явно запрашивает вступление в комнату диспетчеров
      socket.on('join-dispatchers', () => {
        socket.join(DISPATCHER_ROOM);
      });

      socket.on('disconnect', () => {
        socket.leave(DISPATCHER_ROOM);
      });
    });
  }

  /**
   * Отправить обновление заказа только диспетчерам.
   */
  broadcastOrderUpdate(orderData) {
    if (!this.io) {
      console.error('Socket.io не инициализирован');
      return;
    }
    this.io.to(DISPATCHER_ROOM).emit('new-order', orderData);
  }
}

module.exports = new SocketBroadcast();
