const { CourierReliability } = require('../models');

// Пересчёт надёжности курьера.
//
// До этого `rating` только читался в скоринге подбора (geo.js), но не писался
// нигде, кроме тестовых фикстур. В рабочей базе строк не было вовсе, поэтому
// COALESCE(cr.rating, 5.0) всегда возвращал 5.0 — слагаемое `rating × 30` было
// одинаковым для всех и на выбор не влияло. Здесь появляется сам сигнал.

/** Вес нового события. 0.2 → «память» примерно на десяток последних ответов. */
const ALPHA = parseFloat(process.env.RELIABILITY_ALPHA) || 0.2;

const MIN_RATING = 1.0;
const MAX_RATING = 5.0;

/**
 * Оценка за одно событие. Игнор хуже отказа: отказ хотя бы освобождает заказ
 * сразу, а молчание держит его в Waiting до истечения TTL.
 */
const EVENT_SCORE = {
  accept: 5.0,
  reject: 2.0,
  timeout: 1.0,
};

const clamp = (v) => Math.min(MAX_RATING, Math.max(MIN_RATING, v));

/** Экспоненциальное скользящее среднее. */
const ewma = (previous, value) =>
  previous == null ? value : previous * (1 - ALPHA) + value * ALPHA;

/**
 * Учесть реакцию курьера на приглашение.
 *
 * @param {string} courierId
 * @param {'accept'|'reject'|'timeout'} event
 * @param {number|null} [responseSeconds] — сколько секунд думал; только для accept
 */
async function recordInvitationResponse(courierId, event, responseSeconds = null) {
  const score = EVENT_SCORE[event];
  if (!courierId || score === undefined) return null;

  try {
    // Строка появляется при первой же реакции: signup её не создаёт
    const [row] = await CourierReliability.findOrCreate({
      where: { courier_id: courierId },
      defaults: {},
    });

    const updates = { rating: clamp(ewma(row.rating, score)) };

    if (event === 'accept' && Number.isFinite(responseSeconds) && responseSeconds >= 0) {
      // 0 в БД означает «замеров не было» — трактуем как отсутствие истории
      const previous = row.avg_time_order_acceptance || null;
      updates.avg_time_order_acceptance = ewma(previous, responseSeconds);
    }

    await row.update(updates);
    return row;
  } catch (err) {
    // Рейтинг — вторичный сигнал: его сбой не должен ломать приём заказа
    console.error(`Не удалось обновить надёжность курьера ${courierId}:`, err.message);
    return null;
  }
}

module.exports = { recordInvitationResponse, EVENT_SCORE, ALPHA };
