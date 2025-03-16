const { Sequelize } = require("sequelize");
const path = require("path");
const fs = require("fs");

const dbUrl = `postgres://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

const sequelize = new Sequelize(dbUrl, {
  dialect: "postgres",
  logging: false,
});

const db = {};

fs.readdirSync(__dirname)
  .filter((file) => file.endsWith(".js") && file !== "index.js" && file !== "message.js" && file !== "chat.js" && file !== "advertisement.js")
  .forEach((file) => {
    const model = require(path.join(__dirname, file))(sequelize);
    db[model.name] = model;
  });

Object.keys(db).forEach((modelName) => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
