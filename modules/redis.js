const Redis = require('ioredis');

const redis = new Redis();

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

module.exports = class RedisModule {
  static async updateCourierStatus(courierId, statusData) {
    const redisKey = `courier:${courierId}:status`;

    try {
      await redis.hset(redisKey, statusData);
      await redis.expire(redisKey, 3600); // TTL: 1 час
    } catch (err) {
      console.error(`Redis: ошибка обновления статуса курьера ${courierId}:`, err);
      throw err;
    }
  }
}
