// dotenv — строго до require('../models'): models/index.js собирает DSN из process.env
// на этапе загрузки модуля, и при обратном порядке получал postgres://undefined:undefined@...
require('dotenv').config();

const { Order, Courier, User } = require('../models');
const { findBestCourier, calculateRoute } = require('../modules/geo');
const { createRedisClient } = require('../modules/redisClient');
const TelegramBot = require('node-telegram-bot-api');

const redis = createRedisClient();

// TELEGRAM_API_URL переопределяет адрес Bot API: тесты направляют его на локальный
// стаб, чтобы прогон не ходил в сеть и уведомления можно было проверить
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false,
  ...(process.env.TELEGRAM_API_URL ? { baseApiUrl: process.env.TELEGRAM_API_URL } : {}),
});

// TTL записи о назначенном курьере: 5 минут
const PENDING_COURIER_TTL = 300;

// Интервал опроса очереди заказов
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS, 10) || 5000;

const REJECTED_KEY = (orderId) => `rejected_order:${orderId}`;
const INVITE_LOCK_KEY = (courierId) => `invite_lock:${courierId}`;

/**
 * Неблокирующий перебор ключей по паттерну через SCAN (BUG-115).
 * KEYS блокирует Redis на больших объёмах — SCAN итерирует курсором.
 */
async function scanKeys(pattern) {
  const found = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/**
 * Преобразовать telegram_id отклонивших курьеров (хранятся в Redis-множестве
 * rejected_order:{orderId}) в список их courier_id для исключения из подбора.
 */
async function getRejectedCourierIds(orderId) {
  const telegramIds = await redis.smembers(REJECTED_KEY(orderId));
  if (!telegramIds.length) return [];

  const couriers = await Courier.findAll({
    attributes: ['id'],
    include: [{ model: User, attributes: [], where: { telegram_id: telegramIds } }],
  });
  return couriers.map((c) => c.id);
}

async function sendTelegramNotification(courierTelegramId, orderId, durationSeconds) {
  const eta = durationSeconds ? `~${Math.round(durationSeconds / 60)} мин` : '';
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Принять', callback_data: `accept:${orderId}` },
          { text: 'Отклонить', callback_data: `reject:${orderId}` },
        ],
      ],
    },
  };

  try {
    await bot.sendMessage(
      courierTelegramId,
      `Новый заказ! ID: ${orderId}.${eta ? ` Время до точки: ${eta}` : ''}`,
      options
    );
  } catch (err) {
    console.error(`Ошибка отправки уведомления курьеру ${courierTelegramId}:`, err.message);
  }
}

/**
 * Вернуть в очередь заказы, приглашение по которым истекло.
 *
 * На время ожидания ответа курьера заказ переводится в Waiting. Если курьер молча
 * проигнорировал уведомление, ключ pending_courier:{orderId} истекает по TTL, а статус
 * остаётся Waiting — воркер выбирает только Pending, поэтому такой заказ больше никогда
 * никому не назначается и теряется. Возвращаем его в Pending, чтобы подобрать другого.
 */
async function requeueExpiredInvitations() {
  const waiting = await Order.findAll({ where: { status: 'Waiting' } });

  for (const order of waiting) {
    const invitationAlive = await redis.exists(`pending_courier:${order.id}`);
    if (invitationAlive) continue;

    // Условный UPDATE: не перетереть статус, если курьер ответил параллельно
    await Order.update(
      { status: 'Pending' },
      { where: { id: order.id, status: 'Waiting' } }
    );
  }
}

async function processOrders() {
  try {
    // Сначала вернуть в очередь заказы с истёкшим приглашением
    await requeueExpiredInvitations();

    const orders = await Order.findAll({ where: { status: 'Pending' } });
    if (orders.length === 0) return;

    for (const order of orders) {
      // Пропустить заказы без геопозиции точки забора
      if (!order.pickup_location) continue;

      const [pickupLon, pickupLat] = order.pickup_location.coordinates;

      // Исключить курьеров, уже отклонивших этот заказ (BUG-103)
      const rejectedCourierIds = await getRejectedCourierIds(order.id);

      // Подобрать курьера, пропуская тех, кто уже держит активное приглашение.
      // invite_lock — атомарный резерв курьера на время ожидания ответа (BUG-108),
      // самоистекает по TTL, поэтому проигнорированное приглашение не «блокирует» курьера навсегда.
      const exclude = [...rejectedCourierIds];
      let best = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await findBestCourier(pickupLat, pickupLon, exclude);
        if (!candidate) break;

        const locked = await redis.set(
          INVITE_LOCK_KEY(candidate.courier_id),
          String(order.id),
          'EX',
          PENDING_COURIER_TTL,
          'NX'
        );
        if (locked === 'OK') {
          best = candidate;
          break;
        }
        // Курьер уже приглашён на другой заказ — пробуем следующего по близости
        exclude.push(candidate.courier_id);
      }

      if (!best) {
        // Нет доступных курьеров с геопозицией — пробуем Redis-fallback
        await processOrderViaRedis(order);
        continue;
      }

      // Получить telegram_id курьера через его User
      const courier = await Courier.findOne({
        where: { id: best.courier_id },
        include: [{ model: User }],
      });

      if (!courier || !courier.User) {
        // Откатить резерв, если курьер «битый»
        await redis.del(INVITE_LOCK_KEY(best.courier_id));
        continue;
      }

      const telegramId = courier.User.telegram_id;

      // Рассчитать маршрут до точки доставки
      let routeToDropoff = null;
      if (order.dropoff_location) {
        const [dropoffLon, dropoffLat] = order.dropoff_location.coordinates;
        try {
          routeToDropoff = await calculateRoute(best.lat, best.lon, dropoffLat, dropoffLon);
        } catch {
          // OSRM недоступен — продолжаем без маршрута
        }
      }

      // Зафиксировать назначенного курьера в Redis (для авторизации в telegramHandler).
      // Ставится ДО перевода в Waiting: иначе requeueExpiredInvitations успела бы увидеть
      // Waiting-заказ без ключа приглашения и сразу вернуть его в Pending.
      await redis.set(
        `pending_courier:${order.id}`,
        String(telegramId),
        'EX',
        PENDING_COURIER_TTL
      );

      // Сохранить расчётные данные в заказ
      const updateData = { status: 'Waiting' };
      if (routeToDropoff) {
        updateData.distance_meters = routeToDropoff.distance_meters;
        updateData.estimated_duration_seconds = routeToDropoff.duration_seconds;
      }
      await order.update(updateData);

      await sendTelegramNotification(telegramId, order.id, best.duration_seconds);
    }
  } catch (err) {
    console.error('Ошибка обработки заказов:', err);
  }
}

/**
 * Fallback: выбор курьера по Redis (для курьеров без геопозиции в БД).
 */
async function processOrderViaRedis(order) {
  const redisRejectedKey = REJECTED_KEY(order.id);
  const keys = await scanKeys('courier:*:status');

  for (const key of keys) {
    const courierData = await redis.hgetall(key);
    if (!courierData || !courierData.telegramId) continue;
    if (courierData.has_order === 'true') continue;

    const isRejected = await redis.sismember(redisRejectedKey, String(courierData.telegramId));
    if (isRejected) continue;

    // courier:{courierId}:status → извлекаем courierId
    const courierId = key.split(':')[1];

    // Атомарно зарезервировать курьера (BUG-108). Занят приглашением — пропускаем.
    const locked = await redis.set(
      INVITE_LOCK_KEY(courierId),
      String(order.id),
      'EX',
      PENDING_COURIER_TTL,
      'NX'
    );
    if (locked !== 'OK') continue;

    await redis.set(
      `pending_courier:${order.id}`,
      String(courierData.telegramId),
      'EX',
      PENDING_COURIER_TTL
    );

    await order.update({ status: 'Waiting' });
    await sendTelegramNotification(courierData.telegramId, order.id, null);
    break;
  }
}

function startPolling() {
  console.log(`Воркер распределения заказов запущен (опрос раз в ${POLL_INTERVAL_MS} мс)`);
  return setInterval(() => {
    processOrders().catch(console.error);
  }, POLL_INTERVAL_MS);
}

// Самозапуск только при прямом вызове `node workers/choose_courier.js` (npm run worker).
// При импорте из index.js воркер стартует явным вызовом startPolling() (BUG-102).
if (require.main === module) {
  startPolling();
}

module.exports = { processOrders, requeueExpiredInvitations, startPolling };
