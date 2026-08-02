'use strict';

// Поля, которых не хватало интерфейсу: карточки получателя и транспорта были
// целиком захардкожены во фронтенде, потому что хранить эти данные было негде.
// Адреса держим текстом рядом с координатами: PostGIS даёт геометрию, но не
// человекочитаемый адрес, а обратное геокодирование — внешняя зависимость.

module.exports = {
  async up(queryInterface, Sequelize) {
    await Promise.all([
      queryInterface.addColumn('orders', 'customer_phone', {
        type: Sequelize.STRING(32),
        allowNull: true,
      }),
      queryInterface.addColumn('orders', 'pickup_address', {
        type: Sequelize.STRING(255),
        allowNull: true,
      }),
      queryInterface.addColumn('orders', 'dropoff_address', {
        type: Sequelize.STRING(255),
        allowNull: true,
      }),
      queryInterface.addColumn('couriers', 'vehicle_model', {
        type: Sequelize.STRING(128),
        allowNull: true,
      }),
      queryInterface.addColumn('couriers', 'license_plate', {
        type: Sequelize.STRING(16),
        allowNull: true,
      }),
      queryInterface.addColumn('couriers', 'payload_kg', {
        type: Sequelize.INTEGER,
        allowNull: true,
      }),
      queryInterface.addColumn('couriers', 'volume_m3', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }),
    ]);
  },

  async down(queryInterface) {
    await Promise.all([
      queryInterface.removeColumn('orders', 'customer_phone'),
      queryInterface.removeColumn('orders', 'pickup_address'),
      queryInterface.removeColumn('orders', 'dropoff_address'),
      queryInterface.removeColumn('couriers', 'vehicle_model'),
      queryInterface.removeColumn('couriers', 'license_plate'),
      queryInterface.removeColumn('couriers', 'payload_kg'),
      queryInterface.removeColumn('couriers', 'volume_m3'),
    ]);
  },
};
