'use strict';

module.exports = {
  async up(queryInterface) {
    // Добавить колонку location типа GEOMETRY(POINT, 4326)
    // DataTypes.GEOMETRY не поддерживает PostGIS напрямую — используем raw SQL
    await queryInterface.sequelize.query(`
      ALTER TABLE couriers_status
      ADD COLUMN IF NOT EXISTS location GEOMETRY(POINT, 4326);
    `);

    // Пространственный индекс для быстрого поиска ST_DWithin / ST_Distance
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_couriers_status_location
      ON couriers_status USING GIST (location);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS idx_couriers_status_location;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE couriers_status DROP COLUMN IF EXISTS location;
    `);
  },
};
