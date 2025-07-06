const Redis = require('ioredis');
const redis = new Redis();

module.exports = class RedisModule {
  static async updateCourierStatus(courierId, statusData) {
    const redisKey = `courier:${courierId}:status`;

    await redis.hmset(redisKey, statusData);
    await redis.expire(redisKey, 3600); // TTL: 1 час
  }
}
