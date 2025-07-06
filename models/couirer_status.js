const { Model, DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {
    class CourierStatus extends Model {
        static associate(models) {
            CourierStatus.belongsTo(models.Courier, { foreignKey: 'courier_id' });
        }
    }

    CourierStatus.init(
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
            },
            has_order: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            last_online_at: {
                type: DataTypes.DATE,
            }
        },
        {
            sequelize,
            modelName: 'CourierStatus',
            tableName: 'couriers_status',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            timestamps: true,
        }
    );

    return CourierStatus;
}


