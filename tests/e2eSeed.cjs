// Наполнение тестовой базы для E2E-прогона Playwright.
//
// ЗАПУСКАЕТСЯ ДО playwright test, а не из globalSetup. Playwright поднимает
// webServer РАНЬШЕ globalSetup, а этот скрипт пересоздаёт базу через
// DROP ... WITH (FORCE). Уже подключившийся бэкенд переживает разрыв и
// переподключается, но оставляет закэшированные OID типов PostGIS — в новой
// базе они другие, и Sequelize перестаёт распознавать geometry: координаты
// приходят на фронтенд как null, маршрут не строится.
//
// Результат пишется в delivery_frontend/e2e/.seed.json — оттуда его читают тесты.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const SEED_FILE = path.resolve(
  __dirname, '..', '..', 'delivery_frontend', 'e2e', '.seed.json'
);

const BACKEND_DIR = path.resolve(__dirname, '..');
process.env.DB_NAME = require('./setup/testDbName.cjs');

// Путь к .env указываем явно: скрипт запускают из каталога фронтенда,
// и по умолчанию dotenv подхватил бы его .env без параметров подключения к БД
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });

const TEST_DB = process.env.DB_NAME;
const COURIER_POINT = { lat: 40.5952146, lon: -74.1827119 }; // Ridgeway Ave, Статен-Айленд
const PICKUP = { lat: 40.601121, lon: -74.1764 };
const DROPOFF = { lat: 40.61, lon: -74.16 };

async function recreateDatabase() {
  if (!TEST_DB.endsWith('_test')) {
    throw new Error(`Небезопасное имя тестовой базы: ${TEST_DB}`);
  }
  const admin = new Client({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }

  execFileSync(
    process.execPath,
    [path.join(BACKEND_DIR, 'node_modules', 'sequelize-cli', 'lib', 'sequelize'),
     'db:migrate', '--env', 'test'],
    { cwd: BACKEND_DIR, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe' }
  );
}

async function seed() {
  const db = require('../models');

  const user = await db.User.create({
    first_name: 'Станислав',
    last_name: 'Тестовый',
    telegram_id: 920211279,
    username: 'e2e_courier',
  });

  const courier = await db.Courier.create({
    user_id: user.id,
    level: 'Experienced',
    vehicle_model: 'Volkswagen Transporter',
    license_plate: 'XYZ-123',
    payload_kg: 1000,
    volume_m3: 5.8,
  });

  await db.sequelize.query(
    `INSERT INTO couriers_status (id, courier_id, has_order, last_online_at, location, created_at, updated_at)
     VALUES (gen_random_uuid(), :cid, true, NOW(),
             ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), NOW(), NOW())`,
    { replacements: { cid: courier.id, lon: COURIER_POINT.lon, lat: COURIER_POINT.lat } }
  );

  await db.CourierReliability.create({ courier_id: courier.id, rating: 4.8, completed_orders: 10 });

  // Заказ уже принят: E2E проверяет отображение и завершение, а не подбор
  const [[order]] = await db.sequelize.query(
    `INSERT INTO orders
       (id, customer_name, customer_phone, status, total_price, is_exclusive,
        executor_id, pickup_location, dropoff_location, pickup_address, dropoff_address,
        distance_meters, estimated_duration_seconds, created_at, updated_at)
     VALUES (gen_random_uuid(), 'Matthew Perry', '+1 718 555-0142', 'Progress', 1500, false,
             :cid,
             ST_SetSRID(ST_MakePoint(:pLon, :pLat), 4326),
             ST_SetSRID(ST_MakePoint(:dLon, :dLat), 4326),
             'Victory Blvd, Staten Island, NY', 'Forest Ave 1200, Staten Island, NY',
             2852, 237, NOW(), NOW())
     RETURNING id`,
    {
      replacements: {
        cid: courier.id,
        pLon: PICKUP.lon, pLat: PICKUP.lat,
        dLon: DROPOFF.lon, dLat: DROPOFF.lat,
      },
    }
  );

  const geoToken = crypto
    .createHmac('sha256', process.env.COOKIE_SECRET || 'defaultSecret')
    .update(String(courier.id))
    .digest('hex');

  await db.sequelize.close();

  return {
    orderId: order.id,
    courierId: courier.id,
    // Ровно та полезная нагрузка, которую signup.js кладёт в localStorage
    tgUser: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      telegram_id: String(user.telegram_id),
      photo_url: '/profile.jpg',
      courierId: courier.id,
      geoToken,
    },
  };
}

(async () => {
  await recreateDatabase();
  const result = await seed();

  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log(`E2E: база засеяна, заказ ${result.orderId}`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
