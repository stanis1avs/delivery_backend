const expressSession = require('express-session');

const sessionMiddleware = expressSession({
  secret: process.env.COOKIE_SECRET ?? 'password',
  resave: false,
  saveUninitialized: false,
});

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next)

const getUserId = (socket) => {
  const userSession = JSON.parse(Object.values(socket.request.sessionStore.sessions))
  return userSession.passport.user
}

module.exports = {expressSession, sessionMiddleware, wrap, getUserId}