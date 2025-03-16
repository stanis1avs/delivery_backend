const Chat = require('../models/chat')
const Message = require('../models/message')

const {getUserId} = require('../middleware/middlewares')

module.exports = class CommunicationModule {
  constructor(socket) {
    this.userId = getUserId(socket)
  }

  subscribe = async function(socket) {
    const chatList = await Chat.find({users: this.userId});

    if (chatList) {
      chatList.forEach(chat => {
        socket.join(chat._id);
      });
    }
  }

  async getHistory (id) {
    const history = await Chat.findOne({users: [id, this.userId]})

    let chatHistory = [];

    for (const msgId of history.messages) {
      const msg = await Message.findById(msgId)
      chatHistory.push(msg);
    }
    socket.emit('chatHistory', {messages: JSON.stringify(chatHistory)});
  }


  async sendMessage(data) {
    const history = await Chat.findOne({users: [data.receiver, this.userId]})

    const message = {
      author: this.userId,
      sentAt: new Date().toISOString(),
      text: data.text,
      readAt: null
    }

    const messageSent = new Message(message)
    const messageToDb = await messageSent.save()

    if (!history) {
      const chat = {
        users: [data.receiver, this.userId],
        createdAt: new Date().toISOString(),
        messages: [messageToDb._id]
      }

    const chatSent = new Chat(chat)
    const chatToDb = await messageSent.save()

    return {messageToDb, roomId: chatToDb._id}
    }

    else {
      await Chat.findByIdAndUpdate(history._id, { messages: [...history.messages, messageToDb._id]})
    }

    return {messageToDb, roomId: history._id}
  }
}