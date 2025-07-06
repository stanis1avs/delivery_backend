const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const { Server } = require('socket.io');
require('dotenv').config();

const signinRouter = require('./routers/signinRouter');
const externalRouter = require('./routers/externalRouter');
const signupRouter = require('./routers/signup');
const expressSession = require('express-session');
const initializeTelegramHandler = require('./telegramHandler');
const socketBroadcast = require('./websocketServer');

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
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
})

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});


app.use('/external-api', externalRouter);
app.use('/api/signin', signinRouter);
app.use('/api/signup', signupRouter);


async function start() {
  try {
    await pool.connect();
    console.log('Connected to PostgreSQL');
    server.listen(port, () => console.log(`Server running on port ${port}`));

    socketBroadcast.init(io); 
    initializeTelegramHandler();
  } catch (err) {
    console.log('Failed to connect to the database:', err);
  }
}

start()

