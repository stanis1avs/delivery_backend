const express = require('express');
const cors = require('cors');
const http = require('http');
const { Pool } = require('pg');
const { Server } = require('socket.io');
require('dotenv').config();

const externalRouter = require('./routers/externalRouter');
const signupRouter = require('./routers/signup');
const geoRouter = require('./routers/geoRouter');
const expressSession = require('express-session');
const initializeTelegramHandler = require('./telegramHandler');
const socketBroadcast = require('./websocketServer');

const app = express()
const port = process.env.PORT

const pool = new Pool({
  user: process.env.DB_USERNAME,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));
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
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
})

app.use('/external-api', externalRouter);
app.use('/api/signup', signupRouter);
app.use('/api/geo', geoRouter);


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

