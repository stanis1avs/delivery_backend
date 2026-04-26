const axios = require('axios');
const { sequelize } = require('../models');

const OSRM_URL = process.env.OSRM_URL || 'http://localhost:5000';

/**
 * Обновить геопозицию курьера в БД.
 * @param {string} courierId  — UUID курьера
 * @param {number} lat        — широта
 * @param {number} lon        — долгота
 */
async function updateCourierLocation(courierId, lat, lon) {
  await sequelize.query(
    `UPDATE couriers_status
     SET location = ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
         last_online_at = NOW()
     WHERE courier_id = :courierId`,
    {
      replacements: { lon, lat, courierId },
      type: sequelize.QueryTypes.UPDATE,
    }
  );
}

/**
 * Найти доступных курьеров в радиусе radiusMeters от точки (lat, lon).
 * Возвращает массив { courier_id, distance_meters }, отсортированный по дистанции.
 */
async function findNearbyCouriers(lat, lon, radiusMeters = 5000) {
  return sequelize.query(
    `SELECT
       cs.courier_id,
       ST_Distance(
         cs.location::geography,
         ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
       ) AS distance_meters
     FROM couriers_status cs
     WHERE
       cs.has_order = false
       AND cs.location IS NOT NULL
       AND ST_DWithin(
         cs.location::geography,
         ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
         :radius
       )
     ORDER BY distance_meters ASC
     LIMIT 10`,
    {
      replacements: { lon, lat, radius: radiusMeters },
      type: sequelize.QueryTypes.SELECT,
    }
  );
}

/**
 * Запросить маршрут у OSRM между двумя точками.
 * @returns {{ distance_meters: number, duration_seconds: number, geometry: object }}
 */
async function calculateRoute(fromLat, fromLon, toLat, toLon) {
  const url = `${OSRM_URL}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}`;

  const { data } = await axios.get(url, {
    params: { overview: 'full', geometries: 'geojson', steps: false },
    timeout: 5000,
  });

  if (!data.routes || data.routes.length === 0) {
    throw new Error('OSRM: маршрут не найден');
  }

  const route = data.routes[0];
  return {
    distance_meters: Math.round(route.distance),
    duration_seconds: Math.round(route.duration),
    geometry: route.geometry,
  };
}

/**
 * Выбрать лучшего курьера для заказа.
 * Критерий: минимальное время OSRM-маршрута до точки pickup,
 * скорректированное рейтингом курьера.
 *
 * @param {number} pickupLat
 * @param {number} pickupLon
 * @returns {object|null} — строка с courier_id, lat, lon, rating | null если нет доступных
 */
async function findBestCourier(pickupLat, pickupLon) {
  const nearby = await findNearbyCouriers(pickupLat, pickupLon, 10000);
  if (nearby.length === 0) return null;

  // Обогатить топ-5 кандидатов реальным OSRM-временем
  const candidates = await Promise.all(
    nearby.slice(0, 5).map(async (c) => {
      const [row] = await sequelize.query(
        `SELECT
           cs.courier_id,
           ST_Y(cs.location::geometry) AS lat,
           ST_X(cs.location::geometry) AS lon,
           COALESCE(cr.rating, 5.0) AS rating
         FROM couriers_status cs
         LEFT JOIN courier_reliabilities cr ON cr.courier_id = cs.courier_id
         WHERE cs.courier_id = :id`,
        {
          replacements: { id: c.courier_id },
          type: sequelize.QueryTypes.SELECT,
        }
      );

      if (!row) return null;

      try {
        const route = await calculateRoute(row.lat, row.lon, pickupLat, pickupLon);
        return { ...row, duration_seconds: route.duration_seconds };
      } catch {
        // OSRM недоступен или маршрут не найден — используем эвристику
        return { ...row, duration_seconds: c.distance_meters / 8 }; // ~30 км/ч
      }
    })
  );

  const valid = candidates.filter(Boolean);
  if (valid.length === 0) return null;

  // Сортировка: меньше время прибытия + бонус за рейтинг (30 сек за 1 звезду)
  valid.sort((a, b) => {
    const scoreA = a.duration_seconds - (a.rating || 0) * 30;
    const scoreB = b.duration_seconds - (b.rating || 0) * 30;
    return scoreA - scoreB;
  });

  return valid[0];
}

module.exports = { updateCourierLocation, findNearbyCouriers, calculateRoute, findBestCourier };
