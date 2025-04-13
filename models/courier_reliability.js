const { Model, DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {
  class CourierReliability extends Model {
    static associate(models) {
        CourierReliability.belongsTo(models.Courier, { foreignKey: 'courier_id' });
    }
  }

  CourierReliability.init(
    {
        id: {
            type: DataTypes.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
        },
        rating: {
            type: DataTypes.FLOAT,
            defaultValue: 5.0,
        },
        completed_orders: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
        avg_time_order_acceptance: {
            type: DataTypes.FLOAT,
            allowNull: false,
            defaultValue: 0.0,
        },
    },
    {
        sequelize,
        modelName: 'CourierReliability',
        tableName: 'couriers_reliability',
        timestamps: true,
    }
  );

  return CourierReliability;
};
