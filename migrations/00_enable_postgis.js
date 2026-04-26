'use strict';

// Эта миграция должна выполняться первой (имя начинается с 00_).
// Активирует расширение PostGIS в базе данных.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS postgis;');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP EXTENSION IF EXISTS postgis;');
  },
};
