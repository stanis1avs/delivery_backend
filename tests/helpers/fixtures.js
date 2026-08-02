// Фикстуры для тестов подбора курьера.
// Координаты — Статен-Айленд, потому что OSRM загружен экстрактом Нью-Йорка
// (osrm_data/new-york-latest). Для точек вне покрытия OSRM возвращает
// вырожденный маршрут нулевой длины, а не ошибку, — тесты стали бы бессмысленными.

const db = require('../../models');

/** Опорная точка: Ridgeway Avenue, Статен-Айленд. Реальная дорога, снап ~13 м. */
const BASE = { lat: 40.5952146, lon: -74.1827119 };

/** Смещение на север примерно на N метров (1° широты ≈ 111 320 м). */
function north(meters) {
  return { lat: BASE.lat + meters / 111320, lon: BASE.lon };
}

/** Смещение на юг примерно на N метров. */
function south(meters) {
  return { lat: BASE.lat - meters / 111320, lon: BASE.lon };
}

let seq = 0;
const nextSeq = () => ++seq;

/**
 * Создать курьера со статусом и рейтингом.
 *
 * @param {object} opts
 * @param {{lat:number,lon:number}|null} opts.at   — позиция; null → location IS NULL
 * @param {boolean} opts.hasOrder                  — занят ли заказом
 * @param {number}  opts.rating
 * @param {number}  opts.onlineSecondsAgo          — как давно обновлялась позиция
 */
async function createCourier({
  at = BASE,
  hasOrder = false,
  rating = 5.0,
  onlineSecondsAgo = 0,
} = {}) {
  const n = nextSeq();

  const user = await db.User.create({
    first_name: `Courier${n}`,
    last_name: 'Test',
    telegram_id: 900000000 + n,
    username: `courier_${n}`,
  });

  const courier = await db.Courier.create({ user_id: user.id, level: 'Beginner' });

  // location и last_online_at пишем сырым SQL: PostGIS-геометрия и сдвиг времени
  await db.sequelize.query(
    `INSERT INTO couriers_status
       (id, courier_id, has_order, last_online_at, location, created_at, updated_at)
     VALUES (
       gen_random_uuid(), :courierId, :hasOrder,
       NOW() - make_interval(secs => :ago),
       ${at ? 'ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)' : 'NULL'},
       NOW(), NOW()
     )`,
    {
      replacements: {
        courierId: courier.id,
        hasOrder,
        ago: onlineSecondsAgo,
        ...(at ? { lon: at.lon, lat: at.lat } : {}),
      },
    }
  );

  await db.CourierReliability.create({ courier_id: courier.id, rating, completed_orders: 0 });

  return courier;
}

/**
 * Создать заказ.
 *
 * @param {object} opts
 * @param {{lat,lon}|null} opts.pickup   — null → заказ без точки забора
 * @param {{lat,lon}|null} opts.dropoff
 * @param {string} opts.status
 */
async function createOrder({
  pickup = north(800),
  dropoff = north(2500),
  status = 'Pending',
  customerName = 'Test Customer',
} = {}) {
  const n = nextSeq();

  const [[row]] = await db.sequelize.query(
    `INSERT INTO orders
       (id, customer_name, status, total_price, is_exclusive,
        pickup_location, dropoff_location, created_at, updated_at)
     VALUES (
       gen_random_uuid(), :name, :status, 1500, false,
       ${pickup ? 'ST_SetSRID(ST_MakePoint(:pLon, :pLat), 4326)' : 'NULL'},
       ${dropoff ? 'ST_SetSRID(ST_MakePoint(:dLon, :dLat), 4326)' : 'NULL'},
       NOW(), NOW()
     )
     RETURNING id`,
    {
      replacements: {
        name: `${customerName} ${n}`,
        status,
        ...(pickup ? { pLon: pickup.lon, pLat: pickup.lat } : {}),
        ...(dropoff ? { dLon: dropoff.lon, dLat: dropoff.lat } : {}),
      },
    }
  );

  return db.Order.findByPk(row.id);
}

/** Текущее состояние заказа из БД (свежее, без кэша модели). */
async function reloadOrder(orderId) {
  return db.Order.findByPk(orderId);
}

/** Очистить все таблицы между тестами. CASCADE — из-за внешних ключей. */
async function truncateAll() {
  await db.sequelize.query(
    'TRUNCATE orders, couriers_status, couriers_reliability, couriers, users RESTART IDENTITY CASCADE'
  );
}

module.exports = {
  db,
  BASE,
  north,
  south,
  createCourier,
  createOrder,
  reloadOrder,
  truncateAll,
};
