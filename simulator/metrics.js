// Сбор и агрегация метрик прогона.
//
// Качество распределения — не pass/fail, а набор чисел. Тест отвечает
// «назначилось или нет», эти метрики — «насколько хорошо назначилось».

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Коэффициент Джини по распределению заказов между курьерами.
 * 0 — все везут поровну, 1 — всё достаётся одному.
 * Нужен, чтобы «быстро» не оборачивалось выгоранием пары лучших курьеров.
 */
function gini(counts) {
  const values = [...counts].sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return null;

  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  let weighted = 0;
  values.forEach((v, i) => {
    weighted += (i + 1) * v;
  });
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

class Metrics {
  constructor() {
    this.assignments = [];       // успешные назначения
    this.invitations = 0;        // всего разосланных приглашений
    this.rejections = 0;
    this.timeouts = 0;
    this.ordersCreated = 0;
    this.ordersDelivered = 0;
    this.unassignedTicks = 0;    // тики, когда заказ был, а назначить некому
    this.perCourier = new Map(); // courierId → сколько заказов принял
    this.candidateCounts = [];   // сколько кандидатов было у формулы на каждом подборе
  }

  orderCreated() {
    this.ordersCreated += 1;
  }

  /** Сколько свободных курьеров рассматривала формула стоимости. */
  candidates(n) {
    this.candidateCounts.push(n);
  }

  invited() {
    this.invitations += 1;
  }

  rejected() {
    this.rejections += 1;
  }

  timedOut() {
    this.timeouts += 1;
  }

  noCourierAvailable() {
    this.unassignedTicks += 1;
  }

  /**
   * @param {object} a
   * @param {string} a.courierId
   * @param {number} a.pickupEtaSeconds — время в пути до точки забора
   * @param {number} a.waitSeconds — от создания заказа до принятия
   */
  accepted(a) {
    this.assignments.push(a);
    this.perCourier.set(a.courierId, (this.perCourier.get(a.courierId) || 0) + 1);
  }

  delivered() {
    this.ordersDelivered += 1;
  }

  summary() {
    const etas = this.assignments.map((a) => a.pickupEtaSeconds).sort((a, b) => a - b);
    const waits = this.assignments.map((a) => a.waitSeconds).sort((a, b) => a - b);
    const responses = this.invitations || 1;

    return {
      orders_created: this.ordersCreated,
      orders_assigned: this.assignments.length,
      orders_delivered: this.ordersDelivered,
      orders_unassigned: this.ordersCreated - this.assignments.length,

      pickup_eta_median_s: round(quantile(etas, 0.5)),
      pickup_eta_p95_s: round(quantile(etas, 0.95)),
      pickup_eta_max_s: round(etas.at(-1) ?? null),

      // Сколько заказ ждал курьера с момента появления
      wait_median_s: round(quantile(waits, 0.5)),
      wait_p95_s: round(quantile(waits, 0.95)),

      invitations: this.invitations,
      // Приглашений на одно принятие: 1.0 — идеал, выше — курьеров дёргают зря
      invites_per_assignment: round(this.invitations / (this.assignments.length || 1), 2),
      rejection_rate: round(this.rejections / responses, 3),
      timeout_rate: round(this.timeouts / responses, 3),

      // Справедливость нагрузки: 0 — поровну, 1 — всё одному
      load_gini: round(gini([...this.perCourier.values()]), 3),
      couriers_used: this.perCourier.size,

      // Если выбора почти не бывает, любая формула стоимости даст один результат
      candidates_median: round(
        quantile([...this.candidateCounts].sort((a, b) => a - b), 0.5)
      ),
      choice_available_pct: round(
        (100 * this.candidateCounts.filter((n) => n > 1).length) /
          (this.candidateCounts.length || 1)
      ),
    };
  }
}

function round(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { Metrics, gini, quantile };
