const { Kafka } = require("kafkajs");
const { Sequelize } = require('sequelize');
const Redis = require("ioredis");
const TelegramBot = require("node-telegram-bot-api");
const Order = require('../models/order'); 
require("dotenv").config();

// const kafka = new Kafka({
//   clientId: "courier-worker",
//   brokers: ["localhost:9092"],
// });

// const consumer = kafka.consumer({ groupId: "courier-group" });

const sequelize = new Sequelize(`postgres://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);

const OrderModel = Order(sequelize);

const redis = new Redis();
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

async function sendTelegramNotification(courierTelegramId, orderId) {
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Allow", callback_data: `accept:${orderId}` },
          { text: "Disallow", callback_data: `reject:${orderId}` },
        ],
      ],
    },
  };

  try {
    await bot.sendMessage(
      courierTelegramId,
      `New order available to you! Order ID: ${orderId}.`,
      options
    );
  } catch (err) {
    console.error(`Error sending Telegram message to ${courierTelegramId}:`, err);
  }
}

async function processOrders() {
  try {
    const orders = await OrderModel.findAll({ where: { status: "Pending" } });

    if (orders.length === 0) {
      return
    }

    for (const order of orders) {
      const redisRejectedKey = `rejected_order:${order.id}`;
      const keys = await redis.keys("courier:*");

      for (const key of keys) {
        const courierData = await redis.hgetall(key);

        if (courierData.isBusy) continue;

        const isRejected = await redis.sismember(redisRejectedKey, courierData.telegramId);
        if (isRejected) continue;

        console.log(`Sending notification to courier: ${courierData.telegramId}`);
        await sendTelegramNotification(courierData.telegramId, order.id);

        await order.update({ status: "Waiting" });
        break;
      }
    }
  } catch (err) {
    console.error("Error processing orders:", err);
  }
}

function startPolling() {
  setInterval(() => {
    console.log("Checking for new orders...");
    processOrders().catch(console.error);
  }, 5000); 
}

// async function runWorker() {
//   try {
//     await consumer.connect();
//     await consumer.subscribe({ topic: "order_notifications", fromBeginning: true });

//     console.log("Worker is running...");

//     await consumer.run({
//       eachMessage: async ({ message }) => {
//         const order = JSON.parse(message.value.toString());
//         console.log(`New order received: ${JSON.stringify(order)}`);

//         await processOrder(order);
//       },
//     });
//   } catch (err) {
//     console.error("Error in Kafka consumer:", err);
//   }
// }

startPolling();
// runWorker().catch(console.error);
