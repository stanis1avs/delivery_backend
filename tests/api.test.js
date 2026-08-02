// Уровень 2 из TESTING_PLAN.md: A-01…A-10.
//
// Отдельное внимание — авторизации. Это граница безопасности: без неё любой
// может подменить чужую геопозицию и завершить чужой заказ. Мутация
// «verifyCourierToken всегда true» должна ронять тесты этого файла.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';

import fixtures from './helpers/fixtures.js';
import appHelper from './helpers/app.js';
import osrmStub from './helpers/osrmStub.js';

const { db, BASE, north, createCourier, createOrder, reloadOrder, truncateAll } = fixtures;
const { buildApp, authHeaders, courierToken } = appHelper;
const { startOsrmStub, fixedRoute, pointToDeadPort, isOsrmReachable } = osrmStub;

const OSRM_LIVE = await isOsrmReachable();

let app;
let restoreOsrm = null;

beforeAll(() => {
  app = buildApp();
});

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  if (restoreOsrm) {
    await restoreOsrm();
    restoreOsrm = null;
  }
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/geo/courier/location', () => {
  it('A-01: с валидным токеном обновляет позицию', async () => {
    const courier = await createCourier({ at: null });

    const res = await request(app)
      .post('/api/geo/courier/location')
      .set(authHeaders(courier.id))
      .send({ courierId: courier.id, lat: BASE.lat, lon: BASE.lon });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [row] = await db.sequelize.query(
      `SELECT ST_X(location::geometry) AS lon, ST_Y(location::geometry) AS lat
         FROM couriers_status WHERE courier_id = :id`,
      { replacements: { id: courier.id }, type: db.sequelize.QueryTypes.SELECT }
    );
    expect(row.lat).toBeCloseTo(BASE.lat, 5);
    expect(row.lon).toBeCloseTo(BASE.lon, 5);
  });

  it('A-02: без courierId в теле — 400', async () => {
    const courier = await createCourier();

    const res = await request(app)
      .post('/api/geo/courier/location')
      // courierId уходит только заголовком, чтобы пройти авторизацию
      .set(authHeaders(courier.id))
      .send({ lat: BASE.lat, lon: BASE.lon });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/courierId/i);
  });

  it('A-03: некорректная широта — 400', async () => {
    const courier = await createCourier();

    const res = await request(app)
      .post('/api/geo/courier/location')
      .set(authHeaders(courier.id))
      .send({ courierId: courier.id, lat: 999, lon: BASE.lon });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/координат/i);
  });

  it('A-08: без токена — 401', async () => {
    const courier = await createCourier();

    const res = await request(app)
      .post('/api/geo/courier/location')
      .send({ courierId: courier.id, lat: BASE.lat, lon: BASE.lon });

    expect(res.status).toBe(401);
  });

  it('A-08b: с неверным токеном — 401', async () => {
    const courier = await createCourier();

    const res = await request(app)
      .post('/api/geo/courier/location')
      .set('X-Courier-Token', 'deadbeef')
      .send({ courierId: courier.id, lat: BASE.lat, lon: BASE.lon });

    expect(res.status).toBe(401);
  });

  it('A-08c: с токеном ДРУГОГО курьера — 401, подмена чужой позиции невозможна', async () => {
    const victim = await createCourier({ at: BASE });
    const attacker = await createCourier({ at: north(5000) });

    const res = await request(app)
      .post('/api/geo/courier/location')
      // Валидный токен атакующего, но courierId жертвы
      .set('X-Courier-Token', courierToken(attacker.id))
      .send({ courierId: victim.id, lat: 0, lon: 0 });

    expect(res.status).toBe(401);

    // Позиция жертвы не изменилась
    const [row] = await db.sequelize.query(
      `SELECT ST_Y(location::geometry) AS lat FROM couriers_status WHERE courier_id = :id`,
      { replacements: { id: victim.id }, type: db.sequelize.QueryTypes.SELECT }
    );
    expect(row.lat).toBeCloseTo(BASE.lat, 5);
  });
});

describe('GET /api/geo/route', () => {
  it.skipIf(!OSRM_LIVE)('A-04: возвращает маршрут между двумя точками', async () => {
    const to = north(2000);

    const res = await request(app).get('/api/geo/route').query({
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: to.lat,
      toLon: to.lon,
    });

    expect(res.status).toBe(200);
    expect(res.body.distance_meters).toBeGreaterThan(0);
    expect(res.body.duration_seconds).toBeGreaterThan(0);
    expect(res.body.geometry.type).toBe('LineString');
  });

  it('A-05: с пропущенным параметром — 400', async () => {
    const res = await request(app)
      .get('/api/geo/route')
      .query({ fromLat: BASE.lat, fromLon: BASE.lon, toLat: BASE.lat });

    expect(res.status).toBe(400);
  });

  it('A-06: при недоступном OSRM — 502', async () => {
    restoreOsrm = pointToDeadPort();
    const to = north(2000);

    const res = await request(app).get('/api/geo/route').query({
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: to.lat,
      toLon: to.lon,
    });

    expect(res.status).toBe(502);
  });
});

describe('GET /api/geo/couriers/nearby', () => {
  it('A-07: возвращает только онлайн-курьеров в радиусе', async () => {
    const online = await createCourier({ at: north(300) });
    await createCourier({ at: north(300), onlineSecondsAgo: 3600 }); // протух
    await createCourier({ at: north(50000) }); // далеко

    const res = await request(app)
      .get('/api/geo/couriers/nearby')
      .query({ lat: BASE.lat, lon: BASE.lon, radius: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.courier_id)).toEqual([online.id]);
  });

  it('без координат — 400', async () => {
    const res = await request(app).get('/api/geo/couriers/nearby').query({ lat: BASE.lat });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/orders/:id/complete и /revert', () => {
  async function acceptedOrder(courier) {
    const order = await createOrder({ status: 'Progress' });
    await order.update({ executor_id: courier.id });
    await db.CourierStatus.update({ has_order: true }, { where: { courier_id: courier.id } });
    return order;
  }

  it('A-09: исполнитель завершает заказ, курьер освобождается, счётчик растёт', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    const order = await acceptedOrder(courier);

    const res = await request(app)
      .post(`/api/orders/${order.id}/complete`)
      .set(authHeaders(courier.id));

    expect(res.status).toBe(200);
    expect((await reloadOrder(order.id)).status).toBe('Completed');

    const status = await db.CourierStatus.findOne({ where: { courier_id: courier.id } });
    expect(status.has_order).toBe(false);

    const rel = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    expect(rel.completed_orders).toBe(1);
  });

  it('A-10: чужой заказ завершить нельзя — 403', async () => {
    const owner = await createCourier({ at: BASE, hasOrder: true });
    const stranger = await createCourier({ at: north(500) });
    const order = await acceptedOrder(owner);

    const res = await request(app)
      .post(`/api/orders/${order.id}/complete`)
      .set(authHeaders(stranger.id));

    expect(res.status).toBe(403);
    expect((await reloadOrder(order.id)).status).toBe('Progress');
  });

  it('без токена завершить нельзя — 401', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    const order = await acceptedOrder(courier);

    const res = await request(app).post(`/api/orders/${order.id}/complete`);

    expect(res.status).toBe(401);
    expect((await reloadOrder(order.id)).status).toBe('Progress');
  });

  it('несуществующий заказ — 404', async () => {
    const courier = await createCourier({ at: BASE });

    const res = await request(app)
      .post('/api/orders/00000000-0000-0000-0000-000000000000/complete')
      .set(authHeaders(courier.id));

    expect(res.status).toBe(404);
  });

  it('повторное завершение — 409', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    const order = await acceptedOrder(courier);

    await request(app).post(`/api/orders/${order.id}/complete`).set(authHeaders(courier.id));
    const second = await request(app)
      .post(`/api/orders/${order.id}/complete`)
      .set(authHeaders(courier.id));

    expect(second.status).toBe(409);
  });

  it('revert возвращает заказ в Progress и снова занимает курьера', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    const order = await acceptedOrder(courier);

    await request(app).post(`/api/orders/${order.id}/complete`).set(authHeaders(courier.id));
    const res = await request(app)
      .post(`/api/orders/${order.id}/revert`)
      .set(authHeaders(courier.id));

    expect(res.status).toBe(200);
    expect((await reloadOrder(order.id)).status).toBe('Progress');

    const status = await db.CourierStatus.findOne({ where: { courier_id: courier.id } });
    expect(status.has_order).toBe(true);

    const rel = await db.CourierReliability.findOne({ where: { courier_id: courier.id } });
    expect(rel.completed_orders).toBe(0);
  });
});

describe('GET /api/orders/active', () => {
  it('возвращает активные заказы курьера с данными для карточек', async () => {
    const courier = await createCourier({ at: BASE, hasOrder: true });
    await db.Courier.update(
      { vehicle_model: 'VW Transporter', license_plate: 'XYZ-123', payload_kg: 1000, volume_m3: 5.8 },
      { where: { id: courier.id } }
    );
    const order = await createOrder({ status: 'Progress' });
    await order.update({
      executor_id: courier.id,
      customer_phone: '+1 718 555-0142',
      dropoff_address: 'Forest Ave 1200',
    });

    const res = await request(app).get('/api/orders/active').set(authHeaders(courier.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const dto = res.body[0];
    expect(dto.customer_phone).toBe('+1 718 555-0142');
    expect(dto.dropoff_address).toBe('Forest Ave 1200');
    expect(dto.pickup_location).toHaveProperty('lat');
    expect(dto.pickup_location).toHaveProperty('lon');
    expect(dto.vehicle).toMatchObject({ model: 'VW Transporter', plate: 'XYZ-123' });
  });

  it('не отдаёт заказы другого курьера', async () => {
    const owner = await createCourier({ at: BASE, hasOrder: true });
    const other = await createCourier({ at: north(500) });
    const order = await createOrder({ status: 'Progress' });
    await order.update({ executor_id: owner.id });

    const res = await request(app).get('/api/orders/active').set(authHeaders(other.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('без токена — 401', async () => {
    const courier = await createCourier({ at: BASE });
    const res = await request(app).get('/api/orders/active').set('X-Courier-Id', courier.id);
    expect(res.status).toBe(401);
  });
});
