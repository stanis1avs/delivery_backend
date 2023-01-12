module.exports = class Chat {
  constructor(db) {
    this.collection = db.collection('chat');
  }

  async addChat(data) {
    await this.collection.insertOne(data)
  }

  async updateData(history, search) {
    await this.collection.updateOne(history, search)
  }

  async findChat(users) {
    const chat = await this.collection.findOne(users)
    if (chat) {
      return chat
    }
    return null
  }

  // subscribe(socket) {
  // }
};