'use strict';

// BUG-105: telegram_id был INTEGER (макс. 2 147 483 647), чего недостаточно
// для современных Telegram-ID. Переводим колонку в BIGINT на уже мигрированных БД.
// Меняем только тип через raw SQL, чтобы не пересоздавать unique-ограничение.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE users ALTER COLUMN telegram_id TYPE BIGINT;'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE users ALTER COLUMN telegram_id TYPE INTEGER;'
    );
  },
};
