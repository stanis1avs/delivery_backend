const TelegramBot = require('node-telegram-bot-api');
const { createRedisClient } = require('./modules/redisClient');
const OrderModule = require('./modules/orders');
const CourierModule = require('./modules/couriers');
const socketBroadcast = require('./websocketServer');
const { Order } = require('./models');
const { recordInvitationResponse } = require('./modules/reliability');

// Метаданные приглашения кладёт воркер: кто приглашён и когда. Нужны, чтобы
// посчитать время раздумий и обновить рейтинг курьера.
const INVITE_META_KEY = (orderId) => `invite_meta:${orderId}`;

/**
 * Списать реакцию курьера в рейтинг и убрать метаданные приглашения.
 * Ошибки не пробрасываются: рейтинг вторичен по отношению к самому заказу.
 */
async function scoreResponse(courierId, orderId, event) {
  try {
    const raw = await redis.get(INVITE_META_KEY(orderId));
    let responseSeconds = null;

    if (raw) {
      const { sentAt } = JSON.parse(raw);
      if (Number.isFinite(sentAt)) responseSeconds = (Date.now() - sentAt) / 1000;
      await redis.del(INVITE_META_KEY(orderId));
    }

    await recordInvitationResponse(courierId, event, responseSeconds);
  } catch (err) {
    console.error(`Не удалось учесть реакцию курьера ${courierId}:`, err.message);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const redis = createRedisClient();

async function handleOrderRejection(courier_telegram_id, courier_id, order_id) {
  const redis_rejected_key = `rejected_order:${order_id}`;

  try {
    await redis.sadd(redis_rejected_key, String(courier_telegram_id));
    // Условный переход Waiting → Pending одним запросом: заказ мог параллельно уйти
    // в Progress другим обработчиком, и read-modify-write его бы перетёр
    await Order.update(
      { status: 'Pending' },
      { where: { id: order_id, status: 'Waiting' } }
    );
    // Убрать запись о назначенном курьере и освободить резерв (BUG-108)
    await redis.del(`pending_courier:${order_id}`);
    await redis.del(`invite_lock:${courier_id}`);
  } catch (err) {
    console.error(`Ошибка обработки отказа от заказа ${order_id}:`, err);
  }
}

/**
 * Обработать нажатие inline-кнопки «Принять»/«Отклонить».
 *
 * Вынесено из замыкания и экспортируется отдельно, чтобы тесты вызывали его
 * напрямую и могли дождаться завершения: через bot.emit результат не дождаться,
 * а поднимать настоящий polling ради теста незачем.
 */
async function handleCallbackQuery(bot, callback_query) {
  {
    const [action, order_id] = callback_query.data.split(":");
    const courier_telegram_id = callback_query.from.id;
    const callback_id = callback_query.id;

    try {
      const order = await OrderModule.findById(order_id);

      if (!order) {
        await bot.answerCallbackQuery(callback_id, { text: "Заказ не найден.", show_alert: true });
        return;
      }

      // Проверить, что именно этому курьеру был назначен заказ
      const authorizedTelegramId = await redis.get(`pending_courier:${order_id}`);
      if (!authorizedTelegramId || String(authorizedTelegramId) !== String(courier_telegram_id)) {
        await bot.answerCallbackQuery(callback_id, {
          text: "Этот заказ не назначен вам.",
          show_alert: true,
        });
        return;
      }

      // Защита от гонки: заказ должен быть в статусе Waiting
      if (order.status !== 'Waiting') {
        await bot.answerCallbackQuery(callback_id, {
          text: "Статус заказа уже изменён.",
          show_alert: true,
        });
        return;
      }

      const courier = await CourierModule.findByTelegramId(courier_telegram_id);
      if (!courier) {
        await bot.answerCallbackQuery(callback_id, { text: "Курьер не найден.", show_alert: true });
        return;
      }

      if (action === "accept") {
        // Проверка статуса и запись — одним условным UPDATE. Раньше статус
        // проверялся в JS выше, и два одновременных callback_query (двойной тап
        // по «Принять», гонка accept/reject) успевали пройти проверку оба.
        const [accepted] = await Order.update(
          { executor_id: courier.id, status: 'Progress' },
          { where: { id: order_id, status: 'Waiting' } }
        );

        if (accepted === 0) {
          await bot.answerCallbackQuery(callback_id, {
            text: "Статус заказа уже изменён.",
            show_alert: true,
          });
          return;
        }

        // Пометить курьера занятым, чтобы воркер не назначал ему новые заказы (BUG-104)
        await CourierModule.updateCourierStatus(courier.id, { has_order: true });
        await redis.hset(`courier:${courier.id}:status`, 'has_order', 'true');

        // Удалить запись о назначенном курьере и резерв — заказ принят
        await redis.del(`pending_courier:${order_id}`);
        await redis.del(`invite_lock:${courier.id}`);

        await scoreResponse(courier.id, order_id, 'accept');

        await bot.answerCallbackQuery(callback_id, { text: "Заказ принят!" });
        await bot.sendMessage(courier_telegram_id, `Вы приняли заказ ID: ${order_id}.`);

        // Адресная доставка заказа конкретному курьеру (BUG-106, BUG-107).
        // Перечитываем заказ, чтобы отдать актуальный статус, и сериализуем тем же
        // методом, что и REST — карточки не должны зависеть от канала доставки.
        const fresh = await OrderModule.findById(order_id);
        socketBroadcast.broadcastOrderToCourier(
          courier.id,
          OrderModule.serializeForClient(fresh, courier)
        );
      }

      if (action === "reject") {
        await handleOrderRejection(courier_telegram_id, courier.id, order_id);
        await scoreResponse(courier.id, order_id, 'reject');
        await bot.answerCallbackQuery(callback_id, { text: "Заказ отклонён." });
        await bot.sendMessage(courier_telegram_id, `Вы отклонили заказ ID: ${order_id}.`);
      }
    } catch (err) {
      console.error("Ошибка обработки callback_query:", err);
      await bot.answerCallbackQuery(callback_query.id, {
        text: "Произошла ошибка. Попробуйте позже.",
        show_alert: true,
      });
    }
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.polling=true] — в тестах выключается, чтобы бот не опрашивал API
 * @returns {TelegramBot} инстанс бота
 */
function initializeTelegramHandler(options = {}) {
  const bot = new TelegramBot(BOT_TOKEN, {
    polling: options.polling !== false,
    // Тесты направляют Bot API на локальный стаб
    ...(process.env.TELEGRAM_API_URL ? { baseApiUrl: process.env.TELEGRAM_API_URL } : {}),
  });

  bot.on('callback_query', (callback_query) => handleCallbackQuery(bot, callback_query));

  console.log('Telegram Bot инициализирован');
  return bot;
}

module.exports = initializeTelegramHandler;
module.exports.handleCallbackQuery = handleCallbackQuery;
module.exports.handleOrderRejection = handleOrderRejection;
