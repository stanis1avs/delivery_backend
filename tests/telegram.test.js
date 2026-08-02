// Уровень 4 из TESTING_PLAN.md: T-01…T-09.
//
// Проверяется НАСТОЯЩИЙ обработчик колбэков, а не примитив под ним. Тест в
// concurrency.test.js вызывает Order.update напрямую и потому не заметил бы,
// если из handleCallbackQuery убрать проверку результата условного UPDATE.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import TelegramBot from 'node-telegram-bot-api';

import fixtures from './helpers/fixtures.js';
import telegramStub from './helpers/telegramStub.js';
import redisClient from '../modules/redisClient.js';

const { db, BASE, north, createCourier, createOrder, reloadOrder, truncateAll } = fixtures;
const { startTelegramStub } = telegramStub;
const { createRedisClient } = redisClient;

const PENDING_KEY = (id) => `pending_courier:${id}`;
const INVITE_KEY = (id) => `invite_lock:${id}`;
const REJECTED_KEY = (id) => `rejected_order:${id}`;

let handler;
let bot;
let tg;
let redis;

/** Колбэк ровно в том виде, в каком его присылает Telegram. */
const callback = (action, orderId, telegramId) => ({
  id: `cb-${Math.round(performance.now())}`,
  data: `${action}:${orderId}`,
  from: { id: telegramId },
});

/** Подготовить принятое к ответу состояние: заказ Waiting + активное приглашение. */
async function invited(courier, order) {
  const user = await db.User.findByPk(courier.user_id);
  await redis.set(PENDING_KEY(order.id), String(user.telegram_id), 'EX', 300);
  await redis.set(INVITE_KEY(courier.id), String(order.id), 'EX', 300);
  return user.telegram_id;
}

beforeAll(async () => {
  tg = await startTelegramStub();
  const mod = await import('../telegramHandler.js');
  handler = mod.default.handleCallbackQuery;
  bot = new TelegramBot('000000000:test-token', {
    polling: false,
    baseApiUrl: process.env.TELEGRAM_API_URL,
  });
  redis = createRedisClient();
});

beforeEach(async () => {
  await truncateAll();
  await redis.flushdb();
  tg.clear();
});

afterAll(async () => {
  await redis.quit();
  await db.sequelize.close();
  await tg.close();
});

describe('accept', () => {
  it('T-01: переводит заказ в Progress, снимает приглашение и резерв', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    await handler(bot, callback('accept', order.id, tgId));

    const updated = await reloadOrder(order.id);
    expect(updated.status).toBe('Progress');
    expect(updated.executor_id).toBe(courier.id);

    expect(await redis.get(PENDING_KEY(order.id))).toBeNull();
    expect(await redis.get(INVITE_KEY(courier.id))).toBeNull();
  });

  it('T-06: помечает курьера занятым в БД и в Redis — BUG-104', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    await handler(bot, callback('accept', order.id, tgId));

    const status = await db.CourierStatus.findOne({ where: { courier_id: courier.id } });
    expect(status.has_order).toBe(true);
    expect(await redis.hget(`courier:${courier.id}:status`, 'has_order')).toBe('true');
  });

  it('T-03: чужой заказ принять нельзя — приглашение выдано другому', async () => {
    const invitee = await createCourier({ at: BASE });
    const stranger = await createCourier({ at: north(500) });
    const order = await createOrder({ status: 'Waiting' });
    await invited(invitee, order);

    const strangerTg = (await db.User.findByPk(stranger.user_id)).telegram_id;
    await handler(bot, callback('accept', order.id, strangerTg));

    expect((await reloadOrder(order.id)).status).toBe('Waiting');
    const alerts = tg.sent.filter((s) => s.method === 'answerCallbackQuery');
    expect(alerts.at(-1).payload.text).toMatch(/не назначен вам/i);
  });

  it('T-04: повторный accept уже принятого заказа отклоняется', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    await handler(bot, callback('accept', order.id, tgId));

    // Приглашение снято первым принятием — возвращаем, чтобы дойти до проверки статуса
    await redis.set(PENDING_KEY(order.id), String(tgId), 'EX', 300);
    tg.clear();

    await handler(bot, callback('accept', order.id, tgId));

    const alerts = tg.sent.filter((s) => s.method === 'answerCallbackQuery');
    expect(alerts.at(-1).payload.text).toMatch(/уже изменён/i);
  });

  it('T-05: несуществующий заказ — сообщение «Заказ не найден»', async () => {
    const courier = await createCourier({ at: BASE });
    const tgId = (await db.User.findByPk(courier.user_id)).telegram_id;

    await handler(bot, callback('accept', '00000000-0000-0000-0000-000000000000', tgId));

    const alerts = tg.sent.filter((s) => s.method === 'answerCallbackQuery');
    expect(alerts.at(-1).payload.text).toMatch(/не найден/i);
  });

  it('T-07b: статус изменился МЕЖДУ чтением и записью — accept отклоняется', async () => {
    // Ранний guard `if (order.status !== 'Waiting')` тут не поможет: на момент
    // чтения заказ ещё Waiting. Единственная защита — проверка числа строк,
    // изменённых условным UPDATE. Хук воспроизводит гонку детерминированно.
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    const steal = async () => {
      await db.sequelize.query(`UPDATE orders SET status = 'Progress' WHERE id = :id`, {
        replacements: { id: order.id },
      });
    };
    db.Order.addHook('beforeBulkUpdate', 'raceHook', steal);

    try {
      await handler(bot, callback('accept', order.id, tgId));
    } finally {
      db.Order.removeHook('beforeBulkUpdate', 'raceHook');
    }

    // Заказ достался другому — ни исполнителя, ни занятости проставиться не должно
    expect((await reloadOrder(order.id)).executor_id).toBeNull();

    const status = await db.CourierStatus.findOne({ where: { courier_id: courier.id } });
    expect(status.has_order).toBe(false);

    const alerts = tg.sent.filter((s) => s.method === 'answerCallbackQuery');
    expect(alerts.at(-1).payload.text).toMatch(/уже изменён/i);

    // И курьеру не должно уйти подтверждение о принятии
    const confirmations = tg
      .messages()
      .filter((m) => /приняли заказ/i.test(m.payload.text || ''));
    expect(confirmations).toHaveLength(0);
  });

  it('T-07: заказ не в статусе Waiting принять нельзя (ранний guard)', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    // Кто-то успел раньше между проверкой и записью
    await db.Order.update({ status: 'Progress' }, { where: { id: order.id } });

    await handler(bot, callback('accept', order.id, tgId));

    const updated = await reloadOrder(order.id);
    // Исполнитель не должен перезаписаться
    expect(updated.executor_id).toBeNull();

    const alerts = tg.sent.filter((s) => s.method === 'answerCallbackQuery');
    expect(alerts.at(-1).payload.text).toMatch(/уже изменён/i);
  });
});

describe('reject', () => {
  it('T-02: возвращает заказ в Pending, помнит отказ, снимает приглашение и резерв', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    await handler(bot, callback('reject', order.id, tgId));

    expect((await reloadOrder(order.id)).status).toBe('Pending');
    expect(await redis.sismember(REJECTED_KEY(order.id), String(tgId))).toBe(1);
    expect(await redis.get(PENDING_KEY(order.id))).toBeNull();
    expect(await redis.get(INVITE_KEY(courier.id))).toBeNull();
  });

  it('отказ не освобождает курьера от уже принятого другого заказа', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    await handler(bot, callback('reject', order.id, tgId));

    const status = await db.CourierStatus.findOne({ where: { courier_id: courier.id } });
    expect(status.has_order).toBe(true);
  });
});

describe('T-08: занятость после принятия', () => {
  it('принявший курьер выпадает из подбора', async () => {
    const geo = await import('../modules/geo.js');
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invited(courier, order);

    expect(await geo.default.findBestCourier(BASE.lat, BASE.lon)).not.toBeNull();

    await handler(bot, callback('accept', order.id, tgId));

    expect(await geo.default.findBestCourier(BASE.lat, BASE.lon)).toBeNull();
  });
});
