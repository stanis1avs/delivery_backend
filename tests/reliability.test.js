// Рейтинг курьера: пересчёт по реакции на приглашения.
//
// До появления этого модуля `rating` только читался в скоринге подбора, но не
// писался нигде, кроме фикстур. В рабочей базе строк не было вовсе, поэтому
// COALESCE(cr.rating, 5.0) давал 5.0 всем — слагаемое `rating × 30` было
// константой и на выбор курьера не влияло.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import TelegramBot from 'node-telegram-bot-api';

import fixtures from './helpers/fixtures.js';
import telegramStub from './helpers/telegramStub.js';
import redisClient from '../modules/redisClient.js';
import reliability from '../modules/reliability.js';

const { db, BASE, north, createCourier, createOrder, truncateAll } = fixtures;
const { startTelegramStub } = telegramStub;
const { createRedisClient } = redisClient;
const { recordInvitationResponse, ALPHA } = reliability;

const INVITE_META_KEY = (id) => `invite_meta:${id}`;
const PENDING_KEY = (id) => `pending_courier:${id}`;
const INVITE_KEY = (id) => `invite_lock:${id}`;

let handler;
let worker;
let bot;
let tg;
let redis;

const callback = (action, orderId, telegramId) => ({
  id: `cb-${Math.round(performance.now())}`,
  data: `${action}:${orderId}`,
  from: { id: telegramId },
});

const ratingOf = async (courierId) =>
  (await db.CourierReliability.findOne({ where: { courier_id: courierId } }))?.rating;

beforeAll(async () => {
  tg = await startTelegramStub();
  const mod = await import('../telegramHandler.js');
  handler = mod.default.handleCallbackQuery;
  worker = await import('../workers/choose_courier.js');
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

describe('recordInvitationResponse', () => {
  it('создаёт строку надёжности при первой же реакции', async () => {
    const courier = await createCourier({ at: BASE });
    await db.CourierReliability.destroy({ where: { courier_id: courier.id } });

    await recordInvitationResponse(courier.id, 'accept', 12);

    const row = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    expect(row).not.toBeNull();
  });

  it('отказ снижает рейтинг, принятие возвращает вверх', async () => {
    const courier = await createCourier({ at: BASE, rating: 5.0 });

    await recordInvitationResponse(courier.id, 'reject');
    const afterReject = await ratingOf(courier.id);
    expect(afterReject).toBeLessThan(5.0);

    await recordInvitationResponse(courier.id, 'accept', 5);
    expect(await ratingOf(courier.id)).toBeGreaterThan(afterReject);
  });

  it('игнор бьёт по рейтингу сильнее отказа', async () => {
    const ignorer = await createCourier({ at: BASE, rating: 5.0 });
    const rejecter = await createCourier({ at: north(100), rating: 5.0 });

    await recordInvitationResponse(ignorer.id, 'timeout');
    await recordInvitationResponse(rejecter.id, 'reject');

    // Отказ освобождает заказ сразу, молчание держит его весь TTL
    expect(await ratingOf(ignorer.id)).toBeLessThan(await ratingOf(rejecter.id));
  });

  it('рейтинг не опускается ниже 1.0 при серии игноров', async () => {
    const courier = await createCourier({ at: BASE, rating: 5.0 });

    for (let i = 0; i < 100; i++) {
      await recordInvitationResponse(courier.id, 'timeout');
    }

    const rating = await ratingOf(courier.id);
    expect(rating).toBeGreaterThanOrEqual(1.0);
    expect(rating).toBeLessThan(1.1);
  });

  it('считает скользящее среднее времени отклика', async () => {
    const courier = await createCourier({ at: BASE, rating: 5.0 });

    await recordInvitationResponse(courier.id, 'accept', 10);
    const row1 = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    // Первое измерение берётся как есть
    expect(row1.avg_time_order_acceptance).toBeCloseTo(10, 3);

    await recordInvitationResponse(courier.id, 'accept', 20);
    const row2 = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    expect(row2.avg_time_order_acceptance).toBeCloseTo(10 * (1 - ALPHA) + 20 * ALPHA, 3);
  });

  it('не роняет вызывающий код при неизвестном курьере', async () => {
    await expect(
      recordInvitationResponse('00000000-0000-0000-0000-000000000000', 'accept', 1)
    ).resolves.toBeNull();
  });
});

describe('рейтинг влияет на подбор', () => {
  it('после отказов курьер проигрывает равному по времени конкуренту', async () => {
    const geo = await import('../modules/geo.js');

    const sloppy = await createCourier({ at: BASE, rating: 5.0 });
    const reliable = await createCourier({ at: BASE, rating: 5.0 });

    // До падения рейтинга оба равны — выбор определяется прочими факторами
    for (let i = 0; i < 5; i++) await recordInvitationResponse(sloppy.id, 'timeout');

    const best = await geo.default.findBestCourier(BASE.lat, BASE.lon);
    expect(best.courier_id).toBe(reliable.id);
  });
});

describe('реакция на приглашение попадает в рейтинг', () => {
  async function invite(courier, order, sentAgoMs = 0) {
    const user = await db.User.findByPk(courier.user_id);
    await redis.set(PENDING_KEY(order.id), String(user.telegram_id), 'EX', 300);
    await redis.set(INVITE_KEY(courier.id), String(order.id), 'EX', 300);
    await redis.set(
      INVITE_META_KEY(order.id),
      JSON.stringify({ courierId: courier.id, sentAt: Date.now() - sentAgoMs }),
      'EX',
      600
    );
    return user.telegram_id;
  }

  it('accept повышает рейтинг и фиксирует время раздумий', async () => {
    const courier = await createCourier({ at: BASE, rating: 3.0 });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invite(courier, order, 8000);

    await handler(bot, callback('accept', order.id, tgId));

    const row = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    expect(row.rating).toBeGreaterThan(3.0);
    expect(row.avg_time_order_acceptance).toBeGreaterThan(7);
    expect(row.avg_time_order_acceptance).toBeLessThan(15);

    // Метаданные должны быть убраны, иначе таймаут засчитается повторно
    expect(await redis.get(INVITE_META_KEY(order.id))).toBeNull();
  });

  it('reject снижает рейтинг', async () => {
    const courier = await createCourier({ at: BASE, rating: 5.0 });
    const order = await createOrder({ status: 'Waiting' });
    const tgId = await invite(courier, order);

    await handler(bot, callback('reject', order.id, tgId));

    expect(await ratingOf(courier.id)).toBeLessThan(5.0);
  });

  it('истёкшее приглашение засчитывается как игнор тому, кого приглашали', async () => {
    const courier = await createCourier({ at: BASE, rating: 5.0 });
    const order = await createOrder({ status: 'Waiting' });

    // Приглашение истекло: pending_courier нет, метаданные ещё живы
    await redis.set(
      INVITE_META_KEY(order.id),
      JSON.stringify({ courierId: courier.id, sentAt: Date.now() - 300000 }),
      'EX',
      600
    );

    await worker.requeueExpiredInvitations();

    expect(await ratingOf(courier.id)).toBeLessThan(5.0);
    expect(await redis.get(INVITE_META_KEY(order.id))).toBeNull();
  });
});
