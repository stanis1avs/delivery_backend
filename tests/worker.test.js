// Уровень 3 из TESTING_PLAN.md: W-01…W-08 плюс таймаут приглашения (N-05).
//
// processOrders вызывается напрямую, а не через setInterval: тест не должен
// зависеть от таймингов. Redis настоящий, но в отдельной логической базе
// (REDIS_DB=1) — иначе SCAN courier:*:status подхватил бы ключи рабочего
// приложения. Telegram подменён локальным HTTP-стабом.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

import fixtures from './helpers/fixtures.js';
import osrmStub from './helpers/osrmStub.js';
import telegramStub from './helpers/telegramStub.js';
import redisClient from '../modules/redisClient.js';

const { db, BASE, north, createCourier, createOrder, reloadOrder, truncateAll } = fixtures;
const { startOsrmStub, fixedRoute, pointToDeadPort } = osrmStub;
const { startTelegramStub } = telegramStub;
const { createRedisClient } = redisClient;

const PENDING_KEY = (id) => `pending_courier:${id}`;
const INVITE_KEY = (id) => `invite_lock:${id}`;
const REJECTED_KEY = (id) => `rejected_order:${id}`;

let worker;
let tg;
let redis;
let restoreOsrm = null;

beforeAll(async () => {
  // Стаб поднимается ДО импорта воркера: TelegramBot создаётся при загрузке модуля
  tg = await startTelegramStub();
  worker = await import('../workers/choose_courier.js');
  redis = createRedisClient();
});

beforeEach(async () => {
  await truncateAll();
  await redis.flushdb(); // база 1, рабочие ключи приложения лежат в 0
  tg.clear();
});

afterEach(async () => {
  if (restoreOsrm) {
    await restoreOsrm();
    restoreOsrm = null;
  }
});

afterAll(async () => {
  await redis.quit();
  await db.sequelize.close();
  await tg.close();
});

describe('processOrders — гео-путь', () => {
  it('W-01: назначает курьера, ставит Waiting, создаёт pending_courier с TTL и шлёт уведомление', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder();

    await worker.processOrders();

    const updated = await reloadOrder(order.id);
    expect(updated.status).toBe('Waiting');

    const pending = await redis.get(PENDING_KEY(order.id));
    expect(pending).toBeTruthy();

    const ttl = await redis.ttl(PENDING_KEY(order.id));
    expect(ttl).toBeGreaterThan(250);
    expect(ttl).toBeLessThanOrEqual(300);

    expect(await redis.get(INVITE_KEY(courier.id))).toBe(String(order.id));

    const messages = tg.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0].payload.text).toContain(order.id);
    // Кнопки accept/reject должны уехать вместе с сообщением
    const buttons = messages[0].payload.reply_markup.inline_keyboard[0];
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `accept:${order.id}`,
      `reject:${order.id}`,
    ]);
  });

  it('W-02: пропускает заказ без точки забора, статус не меняется', async () => {
    await createCourier({ at: BASE });
    const order = await createOrder({ pickup: null });

    await worker.processOrders();

    expect((await reloadOrder(order.id)).status).toBe('Pending');
    expect(tg.messages()).toHaveLength(0);
  });

  it('W-04: записывает дистанцию и время маршрута до точки доставки', async () => {
    const stub = await startOsrmStub(fixedRoute({ distance: 4321, duration: 654 }));
    restoreOsrm = stub.close;

    await createCourier({ at: BASE });
    const order = await createOrder();

    await worker.processOrders();

    const updated = await reloadOrder(order.id);
    expect(updated.distance_meters).toBe(4321);
    expect(updated.estimated_duration_seconds).toBe(654);
  });

  it('W-05: при недоступном OSRM всё равно назначает курьера, маршрутные поля пустые', async () => {
    restoreOsrm = pointToDeadPort();

    await createCourier({ at: BASE });
    const order = await createOrder();

    await worker.processOrders();

    const updated = await reloadOrder(order.id);
    expect(updated.status).toBe('Waiting');
    expect(updated.distance_meters).toBeNull();
    expect(updated.estimated_duration_seconds).toBeNull();
    expect(tg.messages()).toHaveLength(1);
  });

  it('W-06: не выбирает курьера, отклонившего этот заказ — BUG-103', async () => {
    const rejecter = await createCourier({ at: north(100) });
    const other = await createCourier({ at: north(1500) });
    const order = await createOrder();

    // Отказ хранится по telegram_id, как его пишет telegramHandler
    const rejecterTg = (await db.User.findByPk(rejecter.user_id)).telegram_id;
    await redis.sadd(REJECTED_KEY(order.id), String(rejecterTg));

    await worker.processOrders();

    expect(await redis.get(INVITE_KEY(rejecter.id))).toBeNull();
    expect(await redis.get(INVITE_KEY(other.id))).toBe(String(order.id));
  });

  it('W-07: два заказа и один свободный курьер — приглашение уходит только по одному', async () => {
    const courier = await createCourier({ at: BASE });
    const first = await createOrder();
    const second = await createOrder();

    await worker.processOrders();

    const statuses = [
      (await reloadOrder(first.id)).status,
      (await reloadOrder(second.id)).status,
    ].sort();

    // Резерв invite_lock не даёт назначить одного курьера дважды за проход (BUG-108)
    expect(statuses).toEqual(['Pending', 'Waiting']);
    expect(tg.messages()).toHaveLength(1);
    expect(await redis.get(INVITE_KEY(courier.id))).toBeTruthy();
  });

  it('W-08: не выбирает курьера вне окна онлайна — BUG-116', async () => {
    await createCourier({ at: BASE, onlineSecondsAgo: 3600 });
    const order = await createOrder();

    await worker.processOrders();

    expect((await reloadOrder(order.id)).status).toBe('Pending');
    expect(tg.messages()).toHaveLength(0);
  });

  it('не трогает заказ, если свободных курьеров нет вообще', async () => {
    await createCourier({ at: BASE, hasOrder: true });
    const order = await createOrder();

    await worker.processOrders();

    expect((await reloadOrder(order.id)).status).toBe('Pending');
  });
});

describe('processOrderViaRedis — fallback', () => {
  it('W-03: назначает курьера из Redis, когда в БД нет подходящих по гео', async () => {
    // Курьер без координат: гео-путь его не найдёт
    const courier = await createCourier({ at: null });
    const user = await db.User.findByPk(courier.user_id);
    await redis.hset(`courier:${courier.id}:status`, {
      telegramId: String(user.telegram_id),
      has_order: 'false',
    });

    const order = await createOrder();

    await worker.processOrders();

    const updated = await reloadOrder(order.id);
    expect(updated.status).toBe('Waiting');
    expect(await redis.get(PENDING_KEY(order.id))).toBe(String(user.telegram_id));
    expect(await redis.get(INVITE_KEY(courier.id))).toBe(String(order.id));
    expect(tg.messages()).toHaveLength(1);
  });

  it('пропускает занятого курьера из Redis', async () => {
    const courier = await createCourier({ at: null });
    const user = await db.User.findByPk(courier.user_id);
    await redis.hset(`courier:${courier.id}:status`, {
      telegramId: String(user.telegram_id),
      has_order: 'true',
    });

    const order = await createOrder();

    await worker.processOrders();

    expect((await reloadOrder(order.id)).status).toBe('Pending');
    expect(tg.messages()).toHaveLength(0);
  });
});

describe('requeueExpiredInvitations — таймаут приглашения (N-05)', () => {
  it('возвращает в очередь заказ, приглашение по которому истекло', async () => {
    const order = await createOrder({ status: 'Waiting' });
    // Ключа pending_courier нет — приглашение считается истёкшим

    await worker.requeueExpiredInvitations();

    expect((await reloadOrder(order.id)).status).toBe('Pending');
  });

  it('не трогает заказ, пока приглашение живо', async () => {
    const order = await createOrder({ status: 'Waiting' });
    await redis.set(PENDING_KEY(order.id), '123456789', 'EX', 300);

    await worker.requeueExpiredInvitations();

    expect((await reloadOrder(order.id)).status).toBe('Waiting');
  });

  it('не трогает уже принятый заказ', async () => {
    const order = await createOrder({ status: 'Progress' });

    await worker.requeueExpiredInvitations();

    expect((await reloadOrder(order.id)).status).toBe('Progress');
  });

  it('истёкший заказ переназначается на следующем проходе', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });

    // Полный проход: сначала реапер вернёт в Pending, потом подбор назначит заново
    await worker.processOrders();

    expect((await reloadOrder(order.id)).status).toBe('Waiting');
    expect(await redis.get(INVITE_KEY(courier.id))).toBe(String(order.id));
    expect(tg.messages()).toHaveLength(1);
  });
});
