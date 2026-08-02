// Уровень 5 из TESTING_PLAN.md: WS-01…WS-04.
//
// Поднимается настоящий socket.io-сервер и подключаются настоящие клиенты:
// адресность комнат нельзя проверить, вызывая методы SocketBroadcast напрямую —
// именно доставка «только своему курьеру» и есть предмет проверки (BUG-107).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import request from 'supertest';

import { createRequire } from 'node:module';

import fixtures from './helpers/fixtures.js';
import appHelper from './helpers/app.js';
import OrderModule from '../modules/orders.js';

// ВАЖНО: singleton берём через require, а не ESM-импортом.
// В vitest `import '../websocketServer.js'` и `require('../websocketServer')`
// возвращают РАЗНЫЕ экземпляры класса. Роутеры используют require, поэтому
// init(io) на импортированном объекте не дошёл бы до geoRouter, и события
// молча никуда не отправлялись бы.
const require = createRequire(import.meta.url);
const socketBroadcast = require('../websocketServer');

const { db, BASE, createCourier, createOrder, truncateAll } = fixtures;
const { buildApp, authHeaders } = appHelper;

let server;
let app;
let baseUrl;
const clients = [];

/** Подключить клиента и дождаться connect. */
function connect() {
  const socket = ioClient(baseUrl, { path: '/socket.io', transports: ['websocket'] });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Дождаться события или вернуть null по таймауту. */
function waitFor(socket, event, ms = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Отправить событие клиенту и дождаться, пока сервер обработает join. */
async function join(socket, event, arg) {
  socket.emit(event, arg);
  // join выполняется на сервере асинхронно; ack нет, поэтому даём круг событий
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeAll(async () => {
  app = buildApp();
  server = http.createServer(app);
  const io = new Server(server, { path: '/socket.io' });
  socketBroadcast.init(io);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await db.sequelize.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('персональные комнаты курьеров', () => {
  it('WS-01: курьер получает свой заказ в комнате courier:{id}', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Progress' });

    const socket = await connect();
    await join(socket, 'join-courier', courier.id);

    const received = waitFor(socket, 'new-order');
    socketBroadcast.broadcastOrderToCourier(
      courier.id,
      OrderModule.serializeForClient(order, courier)
    );

    const payload = await received;
    expect(payload).not.toBeNull();
    expect(payload.id).toBe(order.id);
  });

  it('WS-03: полезная нагрузка содержит координаты как {lat, lon} — BUG-106', async () => {
    const courier = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Progress' });

    const socket = await connect();
    await join(socket, 'join-courier', courier.id);

    const received = waitFor(socket, 'new-order');
    socketBroadcast.broadcastOrderToCourier(
      courier.id,
      OrderModule.serializeForClient(order, courier)
    );

    const payload = await received;
    expect(typeof payload.pickup_location.lat).toBe('number');
    expect(typeof payload.pickup_location.lon).toBe('number');
    expect(typeof payload.dropoff_location.lat).toBe('number');
    expect(typeof payload.dropoff_location.lon).toBe('number');
  });

  it('WS-04: заказ приходит только своему курьеру — BUG-107', async () => {
    const courierA = await createCourier({ at: BASE });
    const courierB = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Progress' });

    const socketA = await connect();
    const socketB = await connect();
    await join(socketA, 'join-courier', courierA.id);
    await join(socketB, 'join-courier', courierB.id);

    const gotA = waitFor(socketA, 'new-order');
    const gotB = waitFor(socketB, 'new-order', 800);

    socketBroadcast.broadcastOrderToCourier(
      courierA.id,
      OrderModule.serializeForClient(order, courierA)
    );

    expect((await gotA)?.id).toBe(order.id);
    expect(await gotB).toBeNull();
  });

  it('подписка на чужую комнату не даёт доступа к своим заказам другого курьера', async () => {
    const courierA = await createCourier({ at: BASE });
    const courierB = await createCourier({ at: BASE });
    const order = await createOrder({ status: 'Progress' });

    const socket = await connect();
    await join(socket, 'join-courier', courierB.id);

    const received = waitFor(socket, 'new-order', 800);
    socketBroadcast.broadcastOrderToCourier(
      courierA.id,
      OrderModule.serializeForClient(order, courierA)
    );

    expect(await received).toBeNull();
  });
});

describe('комната диспетчеров', () => {
  it('WS-02: обновление геопозиции через API долетает подписчикам', async () => {
    const courier = await createCourier({ at: null });

    const socket = await connect();
    await join(socket, 'join-dispatchers');

    const received = waitFor(socket, 'courier-location');

    const res = await request(app)
      .post('/api/geo/courier/location')
      .set(authHeaders(courier.id))
      .send({ courierId: courier.id, lat: BASE.lat, lon: BASE.lon });
    expect(res.status).toBe(200);

    const payload = await received;
    expect(payload).not.toBeNull();
    expect(payload.courierId).toBe(courier.id);
    expect(payload.lat).toBeCloseTo(BASE.lat, 5);
    expect(payload.lon).toBeCloseTo(BASE.lon, 5);
    // Имя подтягивается из связанного User
    expect(payload.name).toMatch(/Courier/);
  });

  it('не подписанный на dispatchers не получает чужие геопозиции', async () => {
    const courier = await createCourier({ at: null });

    const socket = await connect(); // без join-dispatchers
    const received = waitFor(socket, 'courier-location', 800);

    await request(app)
      .post('/api/geo/courier/location')
      .set(authHeaders(courier.id))
      .send({ courierId: courier.id, lat: BASE.lat, lon: BASE.lon });

    expect(await received).toBeNull();
  });
});
