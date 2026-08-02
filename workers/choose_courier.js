const { Order, Courier, User } = require('../models');
const { findBestCourier, calculateRoute } = require('../modules/geo');
const Redis = require('ioredis');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const redis = new Redis();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// TTL записи о назначенном курьере: 5 минут
const PENDING_COURIER_TTL = 300;

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

async function processOrders() {
  try {
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

      // Сохранить расчётные данные в заказ
      const updateData = { status: 'Waiting' };
      if (routeToDropoff) {
        updateData.distance_meters = routeToDropoff.distance_meters;
        updateData.estimated_duration_seconds = routeToDropoff.duration_seconds;
      }
      await order.update(updateData);

      // Зафиксировать назначенного курьера в Redis (для авторизации в telegramHandler)
      await redis.set(
        `pending_courier:${order.id}`,
        String(telegramId),
        'EX',
        PENDING_COURIER_TTL
      );

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
  setInterval(() => {
    processOrders().catch(console.error);
  }, 5000);
}

startPolling();
