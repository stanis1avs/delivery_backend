const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const signupRouter = require('./routers/signup');
const geoRouter = require('./routers/geoRouter');
const ordersRouter = require('./routers/ordersRouter');
const expressSession = require('express-session');
const initializeTelegramHandler = require('./telegramHandler');
const socketBroadcast = require('./websocketServer');
const { startPolling } = require('./workers/choose_courier');
const { sequelize } = require('./models');

const app = express()
const port = process.env.PORT

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));
app.use(express.json());
app.use(
  expressSession({
    // Имя переменной согласовано с .env и middleware (раньше читался несуществующий SESSION_SECRET) (BUG-111)
    secret: process.env.COOKIE_SECRET || 'defaultSecret',
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
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
})

app.use('/api/signup', signupRouter);
app.use('/api/geo', geoRouter);
app.use('/api/orders', ordersRouter);


async function start() {
  try {
    // Проверка соединения через Sequelize — единый ORM проекта (раньше был лишний неосвобождаемый pg.Pool) (BUG-113)
    await sequelize.authenticate();
    console.log('Connected to PostgreSQL (Sequelize)');
    server.listen(port, () => console.log(`Server running on port ${port}`));

    socketBroadcast.init(io);
    initializeTelegramHandler();

    // Воркер распределения заказов раньше не запускался ничем — заказы в Pending
    // никто не обрабатывал (BUG-102). WORKER_IN_PROCESS=false, если воркер поднимается
    // отдельным процессом (npm run worker) — например, при масштабировании.
    if (process.env.WORKER_IN_PROCESS !== 'false') {
      startPolling();
    }
  } catch (err) {
    console.log('Failed to connect to the database:', err);
  }
}

start()

