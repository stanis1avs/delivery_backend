const { Model, DataTypes, Sequelize } = require("sequelize");

module.exports = (sequelize) => {
  class User extends Model {
    static associate(models) {
      User.hasOne(models.Courier, { foreignKey: 'user_id' });
    }
  }

  User.init(
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      first_name: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      last_name: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      telegram_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        unique: true,
      },
      username: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      photo_url: {
        type: DataTypes.STRING(256),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: "User",
      tableName: "users",
      timestamps: true,
      underscored: true,
    }
  );

  return User;
};
