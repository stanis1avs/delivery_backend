const Chat = require('../basicModules/chat')
const Message = require('../basicModules/message')

module.exports = async function (app, io, db)  {
  console.log('Connect communication')
  const chat = new Chat(db)
  const message = new Message(db)

  io.on('connection', (socket) => {
    console.log('connection')
    if (socket.request.isAuthenticated) {
      const userId = socket.request.session.user.id
      // chat.subscribe(socket)
      socket.on('getHistory', async (id) => {
        const history = await chat.findChat([id, userId])
        socket.emit('chatHistory', history.messages);
      })
      socket.on('sendMessage', async (data) => {
        const history = await chat.findChat([data.receiver, userId])
        const message = await message.addMessage({
          author: userId,
          sentAt: new Date().toISOString(),
          text: data.text,
          readAt: null
        })
        if (!history){
          await chat.addChat({
            users: [data.receiver, userId],
            createdAt: new Date().toISOString(),
            messages: [message]
          })
        }
        else {
          await chat.updateData(history, {$set: { messages: [...history.messages, message]}})
        }
      })
    }
  });
};