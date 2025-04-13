'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('couriers_status', {
      id: {
        type: Sequelize.UUID,
        allowNull: false,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      courier_id: {
        type: Sequelize.UUID,
        references: {
          model: 'couriers',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      is_online: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      has_order: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      last_online_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('couriers_status');
  },
};
