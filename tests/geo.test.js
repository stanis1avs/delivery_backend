// Уровень 1 из TESTING_PLAN.md: G-01…G-13.
//
// Тесты идут против ЖИВЫХ PostGIS и OSRM, а не моков. Вся логика подбора живёт
// в SQL (ST_DWithin, фильтр last_online_at, NOT IN), и мок этого слоя проверял бы
// сам мок: BUG-101 (несуществующая таблица courier_reliabilities) юнит-тест с
// заглушкой не поймал бы, а запрос к настоящей базе падает сразу.
//
// OSRM подменяется только там, где иначе тест недетерминирован, и подменяется
// HTTP-стабом, а не моком модуля (см. helpers/osrmStub.js).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import geo from '../modules/geo.js';
import fixtures from './helpers/fixtures.js';
import osrmStub from './helpers/osrmStub.js';

const { db, BASE, north, south, createCourier, truncateAll } = fixtures;
const { startOsrmStub, fixedRoute, pointToDeadPort, isOsrmReachable } = osrmStub;

// Живой OSRM есть локально, но не в CI — там датасет не поднимается
const OSRM_LIVE = await isOsrmReachable();

/** Активный стаб/восстановление адреса OSRM — снимается после каждого теста. */
let restoreOsrm = null;

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

describe('updateCourierLocation', () => {
  it('G-01: записывает координаты и обновляет время последнего выхода на связь', async () => {
    // Курьер заведомо «протухший» и без координат — проверяем оба изменения
    const courier = await createCourier({ at: null, onlineSecondsAgo: 3600 });

    await geo.updateCourierLocation(courier.id, BASE.lat, BASE.lon);

    const [row] = await db.sequelize.query(
      `SELECT ST_X(location::geometry) AS lon,
              ST_Y(location::geometry) AS lat,
              EXTRACT(EPOCH FROM (NOW() - last_online_at)) AS age_seconds
         FROM couriers_status WHERE courier_id = :id`,
      { replacements: { id: courier.id }, type: db.sequelize.QueryTypes.SELECT }
    );

    expect(row.lat).toBeCloseTo(BASE.lat, 5);
    expect(row.lon).toBeCloseTo(BASE.lon, 5);
    expect(Number(row.age_seconds)).toBeLessThan(5);
  });
});

describe('findNearbyCouriers', () => {
  it('G-02: находит курьера в 200 м при радиусе 5 км и считает дистанцию', async () => {
    const courier = await createCourier({ at: north(200) });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found).toHaveLength(1);
    expect(found[0].courier_id).toBe(courier.id);
    // ST_Distance считает по геодезии, поэтому сверяем с допуском
    expect(Number(found[0].distance_meters)).toBeGreaterThan(150);
    expect(Number(found[0].distance_meters)).toBeLessThan(250);
  });

  it('G-03: не возвращает курьера в 50 км при радиусе 10 км', async () => {
    await createCourier({ at: north(50000) });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 10000);

    expect(found).toEqual([]);
  });

  it('G-04: пропускает занятого курьера (has_order = true)', async () => {
    await createCourier({ at: north(200), hasOrder: true });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found).toEqual([]);
  });

  it('G-05: пропускает курьера без координат (location IS NULL)', async () => {
    await createCourier({ at: null });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found).toEqual([]);
  });

  it('G-12: пропускает курьера вне окна онлайна — BUG-116', async () => {
    // Окно по умолчанию 900 с (COURIER_ONLINE_WINDOW_SECONDS)
    await createCourier({ at: north(200), onlineSecondsAgo: 3600 });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found).toEqual([]);
  });

  it('G-12b: курьер внутри окна онлайна возвращается', async () => {
    const courier = await createCourier({ at: north(200), onlineSecondsAgo: 60 });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found.map((c) => c.courier_id)).toEqual([courier.id]);
  });

  it('исключает курьеров из excludeCourierIds', async () => {
    const near = await createCourier({ at: north(200) });
    const far = await createCourier({ at: north(1500) });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000, [near.id]);

    expect(found.map((c) => c.courier_id)).toEqual([far.id]);
  });

  it('сортирует результат по возрастанию дистанции', async () => {
    const far = await createCourier({ at: north(3000) });
    const near = await createCourier({ at: north(300) });
    const mid = await createCourier({ at: north(1500) });

    const found = await geo.findNearbyCouriers(BASE.lat, BASE.lon, 5000);

    expect(found.map((c) => c.courier_id)).toEqual([near.id, mid.id, far.id]);
  });
});

describe('calculateRoute', () => {
  it.skipIf(!OSRM_LIVE)('G-06: возвращает дистанцию, время и геометрию маршрута', async () => {
    // Живой OSRM: координаты Статен-Айленда, экстракт new-york-latest
    const to = north(2000);

    const route = await geo.calculateRoute(BASE.lat, BASE.lon, to.lat, to.lon);

    expect(route.distance_meters).toBeGreaterThan(0);
    expect(route.duration_seconds).toBeGreaterThan(0);
    expect(route.geometry.type).toBe('LineString');
    expect(route.geometry.coordinates.length).toBeGreaterThan(1);
  });

  it('G-07: пробрасывает ошибку, когда OSRM недоступен', async () => {
    restoreOsrm = pointToDeadPort();
    const to = north(2000);

    await expect(geo.calculateRoute(BASE.lat, BASE.lon, to.lat, to.lon)).rejects.toThrow();
  });

  it('G-07b: бросает ошибку, если OSRM ответил без маршрутов', async () => {
    const stub = await startOsrmStub(() => ({ code: 'Ok', routes: [] }));
    restoreOsrm = stub.close;

    const to = north(2000);

    await expect(geo.calculateRoute(BASE.lat, BASE.lon, to.lat, to.lon)).rejects.toThrow(
      /маршрут не найден/i
    );
  });
});

describe('findBestCourier', () => {
  it('G-08: из двух курьеров выбирает ближнего', async () => {
    const near = await createCourier({ at: north(300) });
    await createCourier({ at: north(4000) });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    expect(best.courier_id).toBe(near.id);
  });

  it('G-09: при равном времени в пути побеждает курьер с большим рейтингом', async () => {
    // Одинаковое время от OSRM — иначе решала бы география, а не рейтинг
    const stub = await startOsrmStub(fixedRoute({ distance: 1000, duration: 300 }));
    restoreOsrm = stub.close;

    const weak = await createCourier({ at: north(500), rating: 3.0 });
    const strong = await createCourier({ at: south(500), rating: 5.0 });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    // Скоринг: duration − rating × 30 → 300−150 против 300−90
    expect(best.courier_id).toBe(strong.id);
    expect(best.courier_id).not.toBe(weak.id);
  });

  it('G-10: возвращает null, если в радиусе никого нет', async () => {
    await createCourier({ at: north(50000) });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    expect(best).toBeNull();
  });

  it('G-11: не падает на джойне рейтинга — регрессия BUG-101', async () => {
    // Запрос ссылался на несуществующую courier_reliabilities,
    // и findBestCourier валился с relation does not exist
    const courier = await createCourier({ at: north(300), rating: 4.2 });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    expect(best).not.toBeNull();
    expect(best.courier_id).toBe(courier.id);
    expect(Number(best.rating)).toBeCloseTo(4.2, 1);
  });

  it('G-13: пропускает исключённого курьера и берёт следующего — BUG-103', async () => {
    const rejected = await createCourier({ at: north(300) });
    const next = await createCourier({ at: north(1200) });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon, [rejected.id]);

    expect(best.courier_id).toBe(next.id);
  });

  it('при недоступном OSRM использует эвристику и всё равно выбирает курьера', async () => {
    restoreOsrm = pointToDeadPort();

    const courier = await createCourier({ at: north(300) });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    expect(best.courier_id).toBe(courier.id);
    expect(best.duration_seconds).toBeGreaterThan(0);
  });

  it('не выбирает занятого курьера, даже если он ближайший', async () => {
    await createCourier({ at: north(100), hasOrder: true });
    const free = await createCourier({ at: north(2000) });

    const best = await geo.findBestCourier(BASE.lat, BASE.lon);

    expect(best.courier_id).toBe(free.id);
  });
});
