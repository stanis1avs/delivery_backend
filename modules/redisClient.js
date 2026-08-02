const Redis = require('ioredis');

// Единая точка создания клиентов Redis.
//
// Раньше `new Redis()` вызывался в трёх местах с параметрами по умолчанию, из-за
// чего тесты работали в той же логической базе, что и приложение: воркер делает
// SCAN courier:*:status и подхватывал бы рабочие ключи. REDIS_DB позволяет увести
// тесты в отдельную базу (в Redis их 16), не трогая продовое поведение.
function createRedisClient(options = {}) {
  return new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    ...options,
  });
}

module.exports = { createRedisClient };
