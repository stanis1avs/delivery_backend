const { Model, DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {
    class Order extends Model {
        static associate(models) {
            Order.belongsTo(models.Courier, { foreignKey: 'executor_id' });
        }
    }

    Order.init(
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
            },
            customer_name: {
                type: DataTypes.STRING(128),
                allowNull: false,
            },
            status: {
                type: DataTypes.ENUM('Pending', 'Waiting', 'Progress', 'Completed'),
                allowNull: false,
                defaultValue: 'Pending',
            },
            total_price: {
                type: DataTypes.FLOAT,
                allowNull: false,
            },
            is_exclusive: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            }
        },
        {
            sequelize,
            modelName: 'Order',
            tableName: 'orders',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            timestamps: true,
        }
    );

    return Order;
};
