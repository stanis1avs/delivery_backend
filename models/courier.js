const { Model, DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {
  class Courier extends Model {
    static associate(models) {
        Courier.hasOne(models.CourierStatus, { foreignKey: 'courier_id' });
        Courier.hasOne(models.CourierReliability, { foreignKey: 'courier_id' });
        Courier.hasOne(models.Order, { foreignKey: 'executor_id' });
        Courier.belongsTo(models.User, { foreignKey: 'user_id' });
    }
  }

  Courier.init(
    {
        id: {
            type: DataTypes.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
        },
        user_id: {
            type: DataTypes.UUID,
            allowNull: false,
            unique: true,
        },
        level: {
            type: DataTypes.ENUM('Beginner', 'Experienced', 'Professional', 'Expert'),
            allowNull: false,
            defaultValue: 'Beginner',
        },
    },
    {
        sequelize,
        modelName: 'Courier',
        tableName: 'couriers',
        timestamps: true,
        createdAt: 'created_at', // явное указание имени столбца для createdAt
        updatedAt: 'updated_at'
    }
  );

  return Courier;
};
