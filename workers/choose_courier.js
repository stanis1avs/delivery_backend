const { Order, Courier, User } = require('../models');
const { findBestCourier, calculateRoute } = require('../modules/geo');
const Redis = require('ioredis');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const redis = new Redis();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// TTL записи о назначенном курьере: 5 минут
const PENDING_COURIER_TTL = 300;

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

      // Найти лучшего курьера по геодистанции и рейтингу
      const best = await findBestCourier(pickupLat, pickupLon);

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

      if (!courier || !courier.User) continue;

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
  const redisRejectedKey = `rejected_order:${order.id}`;
  const keys = await redis.keys('courier:*:status');

  for (const key of keys) {
    const courierData = await redis.hgetall(key);
    if (!courierData || !courierData.telegramId) continue;
    if (courierData.has_order === 'true') continue;

    const isRejected = await redis.sismember(redisRejectedKey, String(courierData.telegramId));
    if (isRejected) continue;

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
