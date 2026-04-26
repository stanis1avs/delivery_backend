const { Order, Courier, User, CourierStatus } = require('../models');
const Redis = require("ioredis");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const redis = new Redis();
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// TTL ожидания ответа курьера: 5 минут
const PENDING_COURIER_TTL = 300;

async function sendTelegramNotification(courierTelegramId, orderId) {
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Принять", callback_data: `accept:${orderId}` },
          { text: "Отклонить", callback_data: `reject:${orderId}` },
        ],
      ],
    },
  };

  try {
    await bot.sendMessage(
      courierTelegramId,
      `Новый заказ! ID: ${orderId}.`,
      options
    );
  } catch (err) {
    console.error(`Ошибка отправки Telegram-сообщения курьеру ${courierTelegramId}:`, err);
  }
}

async function processOrders() {
  try {
    const orders = await Order.findAll({ where: { status: "Pending" } });

    if (orders.length === 0) return;

    for (const order of orders) {
      const redisRejectedKey = `rejected_order:${order.id}`;
      const keys = await redis.keys("courier:*:status");

      for (const key of keys) {
        const courierData = await redis.hgetall(key);

        if (!courierData || !courierData.telegramId) continue;
        if (courierData.has_order === 'true') continue;

        const isRejected = await redis.sismember(redisRejectedKey, String(courierData.telegramId));
        if (isRejected) continue;

        await sendTelegramNotification(courierData.telegramId, order.id);

        // Сохранить, какому курьеру отправлено уведомление (для авторизации в telegramHandler)
        await redis.set(
          `pending_courier:${order.id}`,
          String(courierData.telegramId),
          'EX',
          PENDING_COURIER_TTL
        );

        await order.update({ status: "Waiting" });
        break;
      }
    }
  } catch (err) {
    console.error("Ошибка обработки заказов:", err);
  }
}

function startPolling() {
  setInterval(() => {
    processOrders().catch(console.error);
  }, 5000);
}

startPolling();
