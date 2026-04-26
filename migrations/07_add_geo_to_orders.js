'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS pickup_location GEOMETRY(POINT, 4326),
      ADD COLUMN IF NOT EXISTS dropoff_location GEOMETRY(POINT, 4326),
      ADD COLUMN IF NOT EXISTS distance_meters INTEGER,
      ADD COLUMN IF NOT EXISTS estimated_duration_seconds INTEGER;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS pickup_location,
      DROP COLUMN IF EXISTS dropoff_location,
      DROP COLUMN IF EXISTS distance_meters,
      DROP COLUMN IF EXISTS estimated_duration_seconds;
    `);
  },
};
