const express = require('express');
const http = require('http');
const { MongoClient } = require('mongodb');
const expressSession = require('express-session');
// const FileStore = require('session-file-store')(expressSession);
// const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Server } = require("socket.io");
const registration = require('./functionalModules/registration')
const authentication = require('./functionalModules/authentication')
const showAvertisements = require('./functionalModules/showAdvertisements')
const createAvertisements = require('./functionalModules/createAdvertisements')
const communication = require('./functionalModules/communication')
const configPassport = require('./auth/config-passport');

const app = express()
app.use(express.json());
const port = process.env.PORT ?? 7070
const url = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/project'

const sessionMiddleware = expressSession({
  secret: process.env.COOKIE_SECRET ?? 'password',
  // store: new FileStore({decoder: true}),
  // store: MongoStore.create({ mongoUrl: url, stringify: true }),
  resave: false,
  saveUninitialized: false,
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
})

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next)

MongoClient.connect(url).then((client) => {
  console.log('connect to mongo')
  const dbConnection = client.db()
  registration(app, dbConnection, client)
  app.use(sessionMiddleware)
  app.use(passport.initialize());
  app.use(passport.session());
  configPassport(passport, dbConnection)
  authentication(app)
  io.use(wrap(sessionMiddleware));
  io.use(wrap(passport.initialize()));
  io.use(wrap(passport.session()));
  showAvertisements(app, dbConnection, client)
  createAvertisements(app, dbConnection, client)
  communication(app, io, dbConnection)
}).catch((e) => console.log(e))

server.listen(port)