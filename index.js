const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { passport } = require('./auth/passportAuthentication');
require('dotenv').config();

const signinRouter = require('./routers/signinRouter');
const externalRouter = require('./routers/externalRouter');
const signupRouter = require('./routers/signupRouter');
const advertisementsRouter = require('./routers/advertisementsRouter');
const expressSession = require('express-session');

const CommunicationModule = require('./modules/communicationModule')

// const {sessionMiddleware, session, getUserId, wrap} = require('./middleware/middlewares');

const app = express()
const port = process.env.PORT

const pool = new Pool({
  user: process.env.DB_USERNAME,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

app.use(express.json());
app.use(
  expressSession({
    secret: process.env.SESSION_SECRET || 'defaultSecret',
    resave: false,
    saveUninitialized: false, // Не сохранять неинициализированные сессии
    cookie: {
      secure: process.env.NODE_ENV === 'production', // Использовать secure-куки в продакшене
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, //  (1 день)
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

const server = http.createServer(app);
// const io = new Server(server, {
//   cors: {
//     origin: '*',
//   }
// })

app.use('/external-api', externalRouter);
app.use('/api/signin', signinRouter);
app.use('/api/signup', signupRouter);
app.use('/api/advertisements', advertisementsRouter);


// io.use(wrap(sessionMiddleware));
// io.use(wrap(passport.initialize()));
// io.use(wrap(passport.session()));

// io.on('connection', (socket) => {
//   if(socket.request.isAuthenticated || socket.request.isAuthenticated()) {
//     const communicationModule = new CommunicationModule(socket)

//     communicationModule.subscribe(socket);

//     socket.on('getHistory', communicationModule.getHistory);
//     socket.on('sendMessage', async (data) => {
//       const sendMessageInfo = communicationModule.sendMessage(data)

//       const userId = getUserId(socket)

//       const sockets = await io.fetchSockets();
//       const loggedSockets = sockets.filter(socket => userId);
//       const targetSocket = loggedSockets.find(socket => (userId == data.receiver));
//       if (targetSocket) {
//         targetSocket.join(sendMessageInfo.roomId);
//       }
//       const strg = JSON.stringify(sendMessageInfo.messageToDb);
//       socket.join(sendMessageInfo.roomId);
//       socket.to(sendMessageInfo.roomId).emit('newMessage', {text: strg});
//       socket.emit('newMessage', {text: strg});
//     });
//   }
// })

async function start() {
  try {
    await pool.connect();
    console.log('Connected to PostgreSQL');
    server.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (err) {
    console.log('Failed to connect to the database:', err);
  }
}

start()

