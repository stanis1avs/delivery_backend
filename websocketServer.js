class SocketBroadcast {
  constructor() {
    this.io = null;
  }

  init(ioInstance) {
    this.io = ioInstance;
  }

  broadcastOrderUpdate(orderData) {
    if (!this.io) {
      console.error('Socket.io instance not initialized');
      return;
    }

    this.io.emit('new-order', orderData);
  }
}

module.exports = new SocketBroadcast();