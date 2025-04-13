"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("users", {
      id: {
        type: Sequelize.UUID,
        allowNull: false,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      first_name: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      last_name: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      telegram_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        unique: true,
      },
      username: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      photo_url: {
        type: Sequelize.STRING(256),
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

  async down(queryInterface) {
    await queryInterface.dropTable("users");
  },
};
