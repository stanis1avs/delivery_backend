const express = require('express');
const router = express.Router();
const { Order, CourierStatus, CourierReliability } = require('../models');
const RedisModule = require('../modules/redis');
const { requireCourier } = require('../auth/courierToken');
const { toLatLon } = require('../modules/geo');

/**
 * GET /api/orders/active
 * Активные заказы курьера (статус Progress).
 *
 * Нужен, чтобы Sidebar восстанавливал список после перезагрузки страницы:
 * раньше он наполнялся только событием new-order, поэтому принятый заказ
 * исчезал из интерфейса при F5, хотя в БД оставался.
 */
router.get('/active', requireCourier, async (req, res) => {
  try {
    const orders = await Order.findAll({
      where: { executor_id: req.courierId, status: 'Progress' },
      order: [['updated_at', 'DESC']],
    });

    return res.json(
      orders.map((o) => ({
        id: o.id,
        status: o.status,
        details: o.customer_name || 'Заказ',
        pickup_location: toLatLon(o.pickup_location),
        dropoff_location: toLatLon(o.dropoff_location),
        distance_meters: o.distance_meters,
        estimated_duration_seconds: o.estimated_duration_seconds,
      }))
    );
  } catch (err) {
    console.error('Ошибка получения активных заказов:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * Освободить курьера: снять флаг занятости в БД и Redis.
 */
async function setCourierBusy(courierId, busy) {
  await CourierStatus.update({ has_order: busy }, { where: { courier_id: courierId } });
  await RedisModule.updateCourierStatus(courierId, { has_order: busy ? 'true' : 'false' });
}

/**
 * POST /api/orders/:id/complete
 * Завершить заказ исполнителя: статус → Completed, курьер освобождается,
 * счётчик выполненных заказов увеличивается (BUG-119).
 * Требует токен курьера-исполнителя.
 */
router.post('/:id/complete', requireCourier, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    // Завершить может только назначенный исполнитель
    if (!order.executor_id || String(order.executor_id) !== req.courierId) {
      return res.status(403).json({ error: 'Заказ не принадлежит вам' });
    }
    if (order.status !== 'Progress') {
      return res.status(409).json({ error: 'Заказ не в статусе Progress' });
    }

    await order.update({ status: 'Completed' });
    await setCourierBusy(order.executor_id, false);

    const [rel] = await CourierReliability.findOrCreate({
      where: { courier_id: order.executor_id },
      defaults: {},
    });
    await rel.increment('completed_orders');

    return res.json({ ok: true, status: 'Completed' });
  } catch (err) {
    console.error('Ошибка завершения заказа:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/orders/:id/revert
 * Отменить завершение (грейс-период на фронте): Completed → Progress,
 * курьер снова занят, счётчик откатывается.
 */
router.post('/:id/revert', requireCourier, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    if (!order.executor_id || String(order.executor_id) !== req.courierId) {
      return res.status(403).json({ error: 'Заказ не принадлежит вам' });
    }
    if (order.status !== 'Completed') {
      return res.status(409).json({ error: 'Заказ не в статусе Completed' });
    }

    await order.update({ status: 'Progress' });
    await setCourierBusy(order.executor_id, true);

    const rel = await CourierReliability.findOne({ where: { courier_id: order.executor_id } });
    if (rel && rel.completed_orders > 0) {
      await rel.decrement('completed_orders');
    }

    return res.json({ ok: true, status: 'Progress' });
  } catch (err) {
    console.error('Ошибка отмены завершения заказа:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
