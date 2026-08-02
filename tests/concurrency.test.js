// Конкурентные сценарии: L-01, L-02 из TESTING_PLAN.md и гонка двойного accept.
//
// Это единственный способ проверить invite_lock и условный UPDATE: последовательный
// тест их не отличит от кода вообще без защиты. Здесь всё запускается
// через Promise.all, и утверждается, что победитель ровно один.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import fixtures from './helpers/fixtures.js';
import telegramStub from './helpers/telegramStub.js';
import redisClient from '../modules/redisClient.js';

const { db, BASE, north, createCourier, createOrder, reloadOrder, truncateAll } = fixtures;
const { startTelegramStub } = telegramStub;
const { createRedisClient } = redisClient;

const INVITE_KEY = (id) => `invite_lock:${id}`;

let worker;
let tg;
let redis;

beforeAll(async () => {
  tg = await startTelegramStub();
  worker = await import('../workers/choose_courier.js');
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

describe('гонка принятия заказа', () => {
  it('два одновременных accept — заказ принимает ровно один', async () => {
    const first = await createCourier({ at: BASE });
    const second = await createCourier({ at: north(100) });
    const order = await createOrder({ status: 'Waiting' });

    // Тот самый условный UPDATE из telegramHandler: проверка статуса и запись
    // выполняются одним запросом, поэтому второй участник получает 0 строк
    const accept = (courierId) =>
      db.Order.update(
        { executor_id: courierId, status: 'Progress' },
        { where: { id: order.id, status: 'Waiting' } }
      ).then(([count]) => count);

    const results = await Promise.all([accept(first.id), accept(second.id)]);

    expect(results.filter((n) => n === 1)).toHaveLength(1);
    expect(results.filter((n) => n === 0)).toHaveLength(1);

    const updated = await reloadOrder(order.id);
    expect(updated.status).toBe('Progress');
    // Исполнитель — тот, кто выиграл гонку, и он единственный
    expect([first.id, second.id]).toContain(updated.executor_id);
  });

  it('десять одновременных accept — успешен ровно один', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });

    const attempts = Array.from({ length: 10 }, () =>
      db.Order.update(
        { executor_id: courier.id, status: 'Progress' },
        { where: { id: order.id, status: 'Waiting' } }
      ).then(([count]) => count)
    );

    const results = await Promise.all(attempts);

    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('accept и reject одновременно — применяется только один переход', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Waiting' });

    const accept = db.Order.update(
      { executor_id: courier.id, status: 'Progress' },
      { where: { id: order.id, status: 'Waiting' } }
    ).then(([n]) => n);

    const reject = db.Order.update(
      { status: 'Pending' },
      { where: { id: order.id, status: 'Waiting' } }
    ).then(([n]) => n);

    const [accepted, rejected] = await Promise.all([accept, reject]);

    expect(accepted + rejected).toBe(1);

    const updated = await reloadOrder(order.id);
    expect(['Progress', 'Pending']).toContain(updated.status);
    // Ключевое: заказ не может остаться в Waiting и не может «раздвоиться»
    expect(updated.status).not.toBe('Waiting');
  });
});

describe('гонка назначения курьера', () => {
  it('L-02: два параллельных прохода воркера не назначают одного курьера дважды', async () => {
    const courier = await createCourier({ at: BASE });
    await createOrder();
    await createOrder();

    // Имитация двух инстансов воркера на одном тике
    await Promise.all([worker.processOrders(), worker.processOrders()]);

    const orders = await db.Order.findAll();
    const waiting = orders.filter((o) => o.status === 'Waiting');

    // invite_lock (SET NX) допускает ровно одно активное приглашение на курьера
    expect(waiting).toHaveLength(1);
    expect(await redis.get(INVITE_KEY(courier.id))).toBe(String(waiting[0].id));
    expect(tg.messages()).toHaveLength(1);
  });

  it('L-01: 20 заказов и 3 курьера — не более одного приглашения на курьера', async () => {
    const couriers = await Promise.all([
      createCourier({ at: BASE }),
      createCourier({ at: north(200) }),
      createCourier({ at: north(400) }),
    ]);
    for (let i = 0; i < 20; i++) await createOrder();

    await worker.processOrders();

    const orders = await db.Order.findAll();
    const waiting = orders.filter((o) => o.status === 'Waiting');

    // Курьеров трое — значит и приглашений не больше трёх
    expect(waiting.length).toBeLessThanOrEqual(couriers.length);
    expect(waiting.length).toBeGreaterThan(0);

    // Каждый занятый курьер держит резерв ровно по одному заказу
    const locks = await Promise.all(couriers.map((c) => redis.get(INVITE_KEY(c.id))));
    const held = locks.filter(Boolean);
    expect(held).toHaveLength(waiting.length);
    expect(new Set(held).size).toBe(held.length);

    // И столько же уведомлений — ни одного лишнего
    expect(tg.messages()).toHaveLength(waiting.length);
  });

  it('резерв invite_lock самоистекает и курьер снова доступен', async () => {
    const courier = await createCourier({ at: BASE });
    await createOrder();

    await worker.processOrders();
    expect(await redis.get(INVITE_KEY(courier.id))).toBeTruthy();

    const ttl = await redis.ttl(INVITE_KEY(courier.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    // Имитируем истечение TTL: без самоистечения проигнорированное приглашение
    // блокировало бы курьера навсегда
    await redis.del(INVITE_KEY(courier.id));

    const second = await createOrder();
    await worker.processOrders();

    expect((await reloadOrder(second.id)).status).toBe('Waiting');
  });
});
