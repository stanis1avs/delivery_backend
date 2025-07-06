'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('orders', {
            id: {
                type: Sequelize.UUID,
                allowNull: false,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
            },
            customer_name: {
                type: Sequelize.STRING(128),
                allowNull: false,
            },
            status: {
                type: Sequelize.ENUM('Pending', 'Waiting', 'Completed'),
                allowNull: false,
                defaultValue: 'Pending',
            },
            total_price: {
                type: Sequelize.FLOAT,
                allowNull: false,
            },
            is_exclusive: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            executor_id: {
                type: Sequelize.UUID,
                allowNull: true,
            },
            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.fn("NOW"),
            },
            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.fn("NOW"),
            },
        });
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('orders');
    },
};
