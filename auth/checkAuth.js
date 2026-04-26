const auth = (req, res, next) => {
  if (req.isAuthenticated()) {
    next();
  } else {
    return res.status(401).json({error: "Вы не прошли аутентификацию", status: 'error'})
  }
};

module.exports = auth