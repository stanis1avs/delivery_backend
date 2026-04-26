const TelegramBot = require('node-telegram-bot-api');
const Redis = require("ioredis");
const OrderModule = require('./modules/orders');
const CourierModule = require('./modules/couriers');
const socketBroadcast = require('./websocketServer');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const redis = new Redis();

async function handleOrderRejection(courier_telegram_id, order_id) {
  const redis_rejected_key = `rejected_order:${order_id}`;

  try {
    await redis.sadd(redis_rejected_key, String(courier_telegram_id));
    // Сбросить статус заказа обратно в Pending, чтобы воркер мог назначить другого курьера
    const order = await OrderModule.findById(order_id);
    if (order && order.status === 'Waiting') {
      await order.update({ status: 'Pending' });
    }
    // Убрать запись о назначенном курьере
    await redis.del(`pending_courier:${order_id}`);
  } catch (err) {
    console.error(`Ошибка обработки отказа от заказа ${order_id}:`, err);
  }
}

function initializeTelegramHandler() {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on("callback_query", async (callback_query) => {
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
        await order.update({
          executor_id: courier.id,
          status: "Progress",
        });

        // Удалить запись о назначенном курьере — заказ принят
        await redis.del(`pending_courier:${order_id}`);

        await bot.answerCallbackQuery(callback_id, { text: "Заказ принят!" });
        await bot.sendMessage(courier_telegram_id, `Вы приняли заказ ID: ${order_id}.`);

        socketBroadcast.broadcastOrderUpdate({
          id: order.id,
          status: 'Progress',
          details: order.customer_name || 'Заказ принят курьером',
        });
      }

      if (action === "reject") {
        await handleOrderRejection(courier_telegram_id, order_id);
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
  });

  console.log('Telegram Bot инициализирован');
}

module.exports = initializeTelegramHandler;
