module.exports = class Message {
  constructor(db) {
    this.collection = db.collection('message');
  }

  async addMessage(data) {
    const elem = await this.collection.insertOne(data)
    return {
      _id: elem.insertedId,
      author: data.author,
      text: data.text,
      sentAt: data.sentAt,
      readAt: data.readAt
    }
  }
}