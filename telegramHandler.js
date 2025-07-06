const TelegramBot = require('node-telegram-bot-api');
const Redis = require("ioredis");
const OrderModule = require('./modules/orders');
const CourierModule = require('./modules/couriers');
const socketBroadcast  = require('./websocketServer');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const redis = new Redis();

async function handleOrderRejection(courier_telegram_id, order_id) {
  const redis_rejected_key = `rejected_order:${order_id}`;

  try {
    await redis.sadd(redis_rejected_key, courier_telegram_id);
    console.log(`Courier ${courier_telegram_id} rejected order ${order_id}`);
  } catch (err) {
    console.error(`Error handling order rejection for ${order_id}:`, err);
  }
}

function initializeTelegramHandler() {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on("callback_query", async (callback_query) => {
  const [action, order_id] = callback_query.data.split(":");
  const courier_telegram_id = callback_query.from.id;
  const callback_id = callback_query.id;

  try {
    console.log("Response from:", order_id)
    const order = await OrderModule.findById(order_id);
    const courier = await CourierModule.findByTelegramId(courier_telegram_id);

    if (!order) {
      await bot.answerCallbackQuery(callback_id, { text: "Order not found.", show_alert: true });
      return;
    }

    if (action === "accept") {
      await order.update({
        executor_id: courier.id,
        status: "Progress",
      });

      await bot.answerCallbackQuery(callback_id, { text: "Order accepted!" });
      await bot.sendMessage(courier_telegram_id, `You have accepted Order ID: ${order_id}.`);
      console.log(`Courier ${courier_telegram_id} accepted order ${order_id}`);

      socketBroadcast.broadcastOrderUpdate({
        id: order.id,
        status: 'Out for Delivery',
        details: order.address || 'Адрес не указан',
      });
    }

    if (action === "reject") {
      await handleOrderRejection(courier_telegram_id, order_id);

      await order.update({ status: "Pending" });

      await bot.answerCallbackQuery(callback_id, { text: "Order rejected!" });
      await bot.sendMessage(courier_telegram_id, `You have rejected Order ID: ${order_id}.`);
      console.log(`Courier ${courier_telegram_id} rejected order ${order_id}`);
    }
  } catch (err) {
    console.error("Error handling callback query:", err);
    await bot.answerCallbackQuery(callback_query.id, {
      text: "Произошла ошибка. Попробуйте позже.",
      show_alert: true,
    });
  }
});

  console.log('Telegram Bot initialized');
}

module.exports = initializeTelegramHandler;
