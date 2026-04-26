const express = require('express');
const router = express.Router();
const { updateCourierLocation, calculateRoute, findNearbyCouriers } = require('../modules/geo');
const socketBroadcast = require('../websocketServer');
const { Courier, User } = require('../models');

/**
 * POST /api/geo/courier/location
 * Обновить геопозицию курьера.
 * Body: { courierId: string, lat: number, lon: number }
 *
 * В текущей реализации courierId передаётся в теле запроса,
 * т.к. полноценный session-based checkAuth ещё не интегрирован.
 */
router.post('/courier/location', async (req, res) => {
  const { courierId, lat, lon } = req.body;

  if (!courierId) {
    return res.status(400).json({ error: 'courierId обязателен' });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (
    isNaN(latNum) || isNaN(lonNum) ||
    latNum < -90 || latNum > 90 ||
    lonNum < -180 || lonNum > 180
  ) {
    return res.status(400).json({ error: 'Некорректные координаты' });
  }

  try {
    await updateCourierLocation(courierId, latNum, lonNum);

    // Транслировать позицию диспетчерам через WebSocket
    // Имя берём из связанного User (best-effort, не блокируем ответ)
    Courier.findOne({ where: { id: courierId }, include: [{ model: User }] })
      .then((courier) => {
        const name = courier?.User
          ? `${courier.User.first_name || ''} ${courier.User.last_name || ''}`.trim()
          : 'Курьер';
        socketBroadcast.broadcastCourierLocation(courierId, latNum, lonNum, name);
      })
      .catch(() => {
        socketBroadcast.broadcastCourierLocation(courierId, latNum, lonNum, 'Курьер');
      });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка обновления геопозиции:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * GET /api/geo/route?fromLat=&fromLon=&toLat=&toLon=
 * Рассчитать маршрут между двумя точками через OSRM.
 * Возвращает: { distance_meters, duration_seconds, geometry (GeoJSON) }
 */
router.get('/route', async (req, res) => {
  const { fromLat, fromLon, toLat, toLon } = req.query;

  const coords = [fromLat, fromLon, toLat, toLon].map(parseFloat);
  if (coords.some(isNaN)) {
    return res.status(400).json({ error: 'Передайте fromLat, fromLon, toLat, toLon' });
  }

  try {
    const route = await calculateRoute(...coords);
    return res.json(route);
  } catch (err) {
    console.error('Ошибка OSRM:', err.message);
    return res.status(502).json({ error: 'OSRM недоступен или маршрут не найден' });
  }
});

/**
 * GET /api/geo/couriers/nearby?lat=&lon=&radius=
 * Найти доступных курьеров в радиусе radius метров (по умолчанию 5000).
 */
router.get('/couriers/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseInt(req.query.radius, 10) || 5000;

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Передайте lat и lon' });
  }

  try {
    const couriers = await findNearbyCouriers(lat, lon, radius);
    return res.json(couriers);
  } catch (err) {
    console.error('Ошибка поиска курьеров:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
