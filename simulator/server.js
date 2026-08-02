#!/usr/bin/env node
// Интерактивный стенд: расставить курьеров и заказы на карте, запустить подбор,
// увидеть, кого и почему выбрал алгоритм.
//
//   npm run simulate:ui   →  http://localhost:7099
//
// Подбор выполняет настоящий findBestCourier против настоящих PostGIS и OSRM.
// Работает в отдельной базе delivery_sim — рабочая не затрагивается.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { Client } = require('pg');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SIM_DB = 'delivery_sim';
const PORT = parseInt(process.env.SIM_UI_PORT, 10) || 7099;

process.env.DB_NAME = SIM_DB;
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });
process.env.DB_NAME = SIM_DB;

const { findBestCourier, calculateRoute, defaultScore } = require('../modules/geo');
const { recordInvitationResponse } = require('../modules/reliability');

// ── справочники для автозаполнения ──────────────────────────────────────────

const PRESETS = {
  names: [
    ['Иван', 'Соколов'], ['Пётр', 'Морозов'], ['Алексей', 'Волков'],
    ['Дмитрий', 'Зайцев'], ['Сергей', 'Кузнецов'], ['Николай', 'Орлов'],
    ['Артём', 'Лебедев'], ['Максим', 'Громов'], ['Егор', 'Беляев'],
    ['Илья', 'Ковалёв'], ['Роман', 'Тихонов'], ['Антон', 'Русаков'],
  ],
  vehicles: [
    { model: 'Volkswagen Transporter', payload_kg: 1000, volume_m3: 5.8 },
    { model: 'Ford Transit', payload_kg: 1400, volume_m3: 11.0 },
    { model: 'Mercedes Sprinter', payload_kg: 1500, volume_m3: 14.0 },
    { model: 'Lada Largus', payload_kg: 700, volume_m3: 2.5 },
    { model: 'Citroen Berlingo', payload_kg: 650, volume_m3: 3.3 },
    { model: 'Велокурьер', payload_kg: 15, volume_m3: 0.1 },
  ],
  levels: ['Beginner', 'Experienced', 'Professional', 'Expert'],
  customers: [
    'Matthew Perry', 'Анна Петрова', 'ООО «Ромашка»', 'Сергей Иванов',
    'Кафе «Юг»', 'Мария Соколова', 'Аптека №7', 'Дмитрий Белов',
  ],
  streets: [
    'Victory Blvd', 'Forest Ave', 'Richmond Ave', 'Hylan Blvd',
    'Amboy Rd', 'Bay St', 'Clove Rd', 'Arthur Kill Rd',
  ],
  // Ridgeway Avenue, Статен-Айленд — в зоне покрытия загруженного OSRM
  center: { lat: 40.5952146, lon: -74.1827119 },
};

// ── база ────────────────────────────────────────────────────────────────────

async function ensureDatabase() {
  const admin = new Client({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: 'postgres',
  });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [SIM_DB]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE "${SIM_DB}"`);
  } finally {
    await admin.end();
  }

  execFileSync(
    process.execPath,
    [
      path.join(BACKEND_DIR, 'node_modules', 'sequelize-cli', 'lib', 'sequelize'),
      'db:migrate', '--env', 'test',
    ],
    { cwd: BACKEND_DIR, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe' }
  );
}

const db = require('../models');

async function clearAll() {
  await db.sequelize.query(
    'TRUNCATE orders, couriers_status, couriers_reliability, couriers, users RESTART IDENTITY CASCADE'
  );
}

let telegramSeq = 700000000;

/** Создать курьера из данных формы. */
async function createCourier(input) {
  const user = await db.User.create({
    first_name: input.first_name,
    last_name: input.last_name,
    telegram_id: ++telegramSeq,
    username: `sim_${telegramSeq}`,
  });

  const courier = await db.Courier.create({
    user_id: user.id,
    level: input.level || 'Beginner',
    vehicle_model: input.vehicle_model,
    license_plate: input.license_plate,
    payload_kg: input.payload_kg,
    volume_m3: input.volume_m3,
  });

  await db.sequelize.query(
    `INSERT INTO couriers_status
       (id, courier_id, has_order, last_online_at, location, created_at, updated_at)
     VALUES (gen_random_uuid(), :cid, :busy,
             NOW() - make_interval(secs => :ago),
             ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), NOW(), NOW())`,
    {
      replacements: {
        cid: courier.id,
        busy: !!input.has_order,
        ago: Number(input.offline_seconds) || 0,
        lon: input.lon,
        lat: input.lat,
      },
    }
  );

  await db.CourierReliability.create({
    courier_id: courier.id,
    rating: Number(input.rating) || 5.0,
    completed_orders: Number(input.completed_orders) || 0,
  });

  return { id: courier.id, name: `${input.first_name} ${input.last_name}` };
}

async function createOrder(input) {
  const [[row]] = await db.sequelize.query(
    `INSERT INTO orders
       (id, customer_name, customer_phone, status, total_price, is_exclusive,
        pickup_location, dropoff_location, pickup_address, dropoff_address,
        created_at, updated_at)
     VALUES (gen_random_uuid(), :name, :phone, 'Pending', :price, false,
             ST_SetSRID(ST_MakePoint(:pLon, :pLat), 4326),
             ST_SetSRID(ST_MakePoint(:dLon, :dLat), 4326),
             :pAddr, :dAddr, NOW(), NOW())
     RETURNING id`,
    {
      replacements: {
        name: input.customer_name,
        phone: input.customer_phone || null,
        price: Number(input.total_price) || 1500,
        pLon: input.pickup.lon, pLat: input.pickup.lat,
        dLon: input.dropoff.lon, dLat: input.dropoff.lat,
        pAddr: input.pickup_address || null,
        dAddr: input.dropoff_address || null,
      },
    }
  );
  return { id: row.id };
}

// ── стратегии ───────────────────────────────────────────────────────────────

const STRATEGIES = {
  current: defaultScore,
  nearest: (c) => c.duration_seconds,
  'rating-heavy': (c) => c.duration_seconds - (c.rating || 0) * 120,
};

// ── HTTP ────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui.html')));
app.get('/api/presets', (req, res) => res.json(PRESETS));

/** Заменить сценарий целиком: сначала чистим, потом создаём. */
app.post('/api/scenario', async (req, res) => {
  try {
    await clearAll();
    const couriers = [];
    for (const c of req.body.couriers || []) couriers.push(await createCourier(c));
    const orders = [];
    for (const o of req.body.orders || []) orders.push(await createOrder(o));
    res.json({ couriers, orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Подбор по всем заказам в статусе Pending.
 * Возвращает не только победителя, но и весь список кандидатов с оценками —
 * иначе непонятно, почему алгоритм выбрал именно его.
 */
app.post('/api/dispatch', async (req, res) => {
  try {
    const score = STRATEGIES[req.body.strategy] || defaultScore;
    const orders = await db.Order.findAll({ where: { status: 'Pending' } });
    const result = [];

    for (const order of orders) {
      if (!order.pickup_location) continue;
      const [pLon, pLat] = order.pickup_location.coordinates;

      let candidates = [];
      const best = await findBestCourier(pLat, pLon, [], {
        score,
        onCandidates: (list) => { candidates = list; },
      });

      // Имена подтягиваем отдельно: findBestCourier их не возвращает
      const withNames = await Promise.all(
        candidates.map(async (c) => {
          const courier = await db.Courier.findByPk(c.courier_id, { include: [db.User] });
          return {
            ...c,
            name: courier?.User
              ? `${courier.User.first_name} ${courier.User.last_name}`
              : 'Курьер',
            vehicle: courier?.vehicle_model || null,
          };
        })
      );

      let route = null;
      if (best) {
        try {
          route = await calculateRoute(best.lat, best.lon, pLat, pLon);
        } catch { /* маршрут не обязателен */ }
      }

      result.push({
        orderId: order.id,
        customer: order.customer_name,
        pickup: { lat: pLat, lon: pLon },
        chosen: best ? best.courier_id : null,
        candidates: withNames,
        route: route ? route.geometry : null,
      });
    }

    res.json({ assignments: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** Ответ курьера: влияет на занятость и рейтинг — как в бою. */
app.post('/api/respond', async (req, res) => {
  try {
    const { orderId, courierId, action, responseSeconds } = req.body;

    if (action === 'accept') {
      await db.Order.update(
        { executor_id: courierId, status: 'Progress' },
        { where: { id: orderId, status: 'Pending' } }
      );
      await db.CourierStatus.update({ has_order: true }, { where: { courier_id: courierId } });
    }

    await recordInvitationResponse(courierId, action, responseSeconds ?? null);

    const rel = await db.CourierReliability.findOne({ where: { courier_id: courierId } });
    res.json({ rating: rel ? Number(rel.rating.toFixed(3)) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** Текущее состояние: для перерисовки после действий. */
app.get('/api/state', async (req, res) => {
  const rows = await db.sequelize.query(
    `SELECT c.id, u.first_name, u.last_name, c.vehicle_model,
            cs.has_order,
            ST_Y(cs.location::geometry) AS lat,
            ST_X(cs.location::geometry) AS lon,
            COALESCE(cr.rating, 5.0) AS rating,
            EXTRACT(EPOCH FROM (NOW() - cs.last_online_at)) AS offline_seconds
       FROM couriers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN couriers_status cs ON cs.courier_id = c.id
       LEFT JOIN couriers_reliability cr ON cr.courier_id = c.id`,
    { type: db.sequelize.QueryTypes.SELECT }
  );
  const orders = await db.sequelize.query(
    `SELECT id, customer_name, status, executor_id,
            ST_Y(pickup_location::geometry) AS plat, ST_X(pickup_location::geometry) AS plon,
            ST_Y(dropoff_location::geometry) AS dlat, ST_X(dropoff_location::geometry) AS dlon
       FROM orders`,
    { type: db.sequelize.QueryTypes.SELECT }
  );
  res.json({ couriers: rows, orders });
});

(async () => {
  console.log('Готовлю базу симуляции…');
  await ensureDatabase();
  await db.sequelize.authenticate();
  app.listen(PORT, () => {
    console.log(`\nИнтерактивный стенд: http://localhost:${PORT}`);
    console.log('База: ' + SIM_DB + ' (рабочая не затрагивается)\n');
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
