// Догружает DB_USERNAME/DB_PASSWORD/DB_HOST/DB_PORT/OSRM_URL из .env.
// DB_NAME уже выставлен в vitest.config.js на тестовую базу, и dotenv его
// не тронет: по умолчанию он не перезаписывает существующие переменные.
require('dotenv').config();
