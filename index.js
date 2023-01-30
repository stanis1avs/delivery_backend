const express = require('express');
const http = require('http');
const mongoose = require('mongoose')
const { Server } = require('socket.io');
const { passport } = require('./auth/passportAuthentication');

const signinRouter = require('./routers/signinRouter');
const signupRouter = require('./routers/signupRouter');
const advertisementsRouter = require('./routers/advertisementsRouter');

const CommunicationModule = require('./modules/communicationModule')

const {sessionMiddleware, session, getUserId, wrap} = require('./middleware/middlewares');

const app = express()
const port = process.env.PORT ?? 7070
const url = process.env.DB_HOST ?? 'mongodb://127.0.0.1:27017/project'

app.use(express.json());
app.use(sessionMiddleware)
app.use(passport.initialize());
app.use(passport.session());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
})

app.use('/api/signin', signinRouter);
app.use('/api/signup', signupRouter);
app.use('/api/advertisements', advertisementsRouter);

async function start() {
  try {

    const options = {
      "user": process.env.DB_USERNAME || 'root',
      "pass": process.env.DB_PASSWORD || 'qwerty',
      "dbName": process.env.DB_NAME || 'todos'
    };

    await mongoose.connect(url, options)

    server.listen(port)

  } catch(err) {
    console.log(err)
  }
}

io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

io.on('connection', (socket) => {
  if(socket.request.isAuthenticated || socket.request.isAuthenticated()) {
    const communicationModule = new CommunicationModule(socket)

    communicationModule.subscribe(socket);

    socket.on('getHistory', communicationModule.getHistory);
    socket.on('sendMessage', async (data) => {
      const sendMessageInfo = communicationModule.sendMessage(data)

      const userId = getUserId(socket)

      const sockets = await io.fetchSockets();
      const loggedSockets = sockets.filter(socket => userId);
      const targetSocket = loggedSockets.find(socket => (userId == data.receiver));
      if (targetSocket) {
        targetSocket.join(sendMessageInfo.roomId);
      }
      const strg = JSON.stringify(sendMessageInfo.messageToDb);
      socket.join(sendMessageInfo.roomId);
      socket.to(sendMessageInfo.roomId).emit('newMessage', {text: strg});
      socket.emit('newMessage', {text: strg});
    });
  }
})

start()

