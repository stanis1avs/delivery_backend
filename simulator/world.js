// Мир симуляции: флот курьеров, поток заказов, виртуальное время.
//
// Ключевое: подбор курьера выполняет НАСТОЯЩИЙ findBestCourier против настоящих
// PostGIS и OSRM. Если переписать логику подбора внутри стенда, мы будем мерить
// копию, а не систему — и баги вроде неверного имени таблицы в ней не проявятся.
//
// Смоделировано в самом стенде только то, что на качество подбора не влияет:
// доставка уведомления, реакция курьера и его перемещение. Redis и Telegram не
// участвуют — их механика покрыта тестами (tests/worker.test.js).

const {
  findBestCourier,
  findNearbyCouriers,
  calculateRoute,
  defaultScore,
} = require('../modules/geo');
const { recordInvitationResponse } = require('../modules/reliability');
const { Metrics } = require('./metrics');

/** Детерминированный ГПСЧ (mulberry32): прогоны воспроизводимы по seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Прореживание полилинии: в записи не нужна точность до метра. */
function thin(coords, max = 40) {
  if (coords.length <= max) return coords;
  const step = Math.ceil(coords.length / max);
  const out = coords.filter((_, i) => i % step === 0);
  if (out.at(-1) !== coords.at(-1)) out.push(coords.at(-1));
  return out;
}

/** Профили поведения курьера при получении приглашения. */
const PROFILES = {
  reliable: { accept: 0.95, ignore: 0.02, thinkSeconds: [5, 25] },
  picky: { accept: 0.55, ignore: 0.05, thinkSeconds: [15, 60] },
  flaky: { accept: 0.5, ignore: 0.25, thinkSeconds: [20, 90] },
};

class World {
  /**
   * @param {object} cfg
   * @param {object} cfg.db — модели Sequelize
   * @param {{lat,lon}} cfg.center — центр зоны
   * @param {number} cfg.radiusDeg — разброс точек в градусах
   * @param {number} cfg.couriers — размер флота
   * @param {number} cfg.ordersPerHour — интенсивность потока
   * @param {number} cfg.durationHours — длительность прогона
   * @param {number} cfg.tickSeconds — шаг виртуального времени
   * @param {number} cfg.inviteTtlSeconds — сколько ждём ответа
   * @param {function} [cfg.score] — альтернативная стоимость кандидата
   * @param {number} cfg.seed
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.random = rng(cfg.seed);
    this.metrics = new Metrics();

    this.now = 0;              // виртуальное время, секунды от начала
    this.couriers = [];        // { id, lat, lon, profile, busyUntil, freeAt }
    this.orders = [];          // ожидающие назначения
    this.invites = [];         // активные приглашения
    this.routeCache = new Map();

    // Запись для проигрывателя (--record). Включается флагом, чтобы обычные
    // прогоны не платили за лишние вызовы OSRM и память.
    this.timeline = [];   // отрезки движения и стояния курьеров
    this.orderLog = [];   // жизнь заказов: появился, назначен, доставлен
  }

  between(min, max) {
    return min + this.random() * (max - min);
  }

  randomPoint() {
    const { center, radiusDeg } = this.cfg;
    return {
      lat: center.lat + this.between(-radiusDeg, radiusDeg),
      lon: center.lon + this.between(-radiusDeg, radiusDeg),
    };
  }

  /** Создаёт курьеров в БД: подбор читает именно оттуда. */
  async spawnFleet() {
    const { db, couriers } = this.cfg;
    const names = Object.keys(PROFILES);

    for (let i = 0; i < couriers; i++) {
      const user = await db.User.create({
        first_name: `Sim${i}`,
        last_name: 'Courier',
        telegram_id: 800000000 + i,
        username: `sim_${i}`,
      });
      const courier = await db.Courier.create({ user_id: user.id, level: 'Beginner' });
      const at = this.randomPoint();

      await db.sequelize.query(
        `INSERT INTO couriers_status
           (id, courier_id, has_order, last_online_at, location, created_at, updated_at)
         VALUES (gen_random_uuid(), :cid, false, NOW(),
                 ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), NOW(), NOW())`,
        { replacements: { cid: courier.id, lon: at.lon, lat: at.lat } }
      );
      await db.CourierReliability.create({ courier_id: courier.id, rating: 5.0 });

      const entry = {
        id: courier.id,
        ...at,
        profile: PROFILES[names[i % names.length]],
        profileName: names[i % names.length],
        busyUntil: null,
      };
      this.couriers.push(entry);
      this._idle(entry, 0);
    }
  }

  /** Пуассоновский поток: за тик появляется k заказов. */
  spawnOrders() {
    const perTick = (this.cfg.ordersPerHour / 3600) * this.cfg.tickSeconds;
    let k = 0;
    // Метод Кнута: подходит при малой интенсивности за тик
    const limit = Math.exp(-perTick);
    let p = 1;
    do {
      p *= this.random();
      k += 1;
    } while (p > limit);
    k -= 1;

    for (let i = 0; i < k; i++) {
      const order = {
        id: `o${this.orderLog.length + 1}`,
        pickup: this.randomPoint(),
        dropoff: this.randomPoint(),
        createdAt: this.now,
        rejectedBy: [],
      };
      this.orders.push(order);
      this.metrics.orderCreated();
      if (this.cfg.record) {
        this.orderLog.push({
          id: order.id,
          t0: this.now,
          pickup: [order.pickup.lat, order.pickup.lon],
          dropoff: [order.dropoff.lat, order.dropoff.lon],
          assignedT: null,
          doneT: null,
        });
      }
    }
  }

  /**
   * OSRM с кэшем: в прогоне одни и те же пары встречаются часто.
   * @returns {{seconds: number|null, path: [number,number][]}} path — [lat, lon]
   */
  async routeInfo(from, to) {
    const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}-${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key);

    let info = { seconds: null, path: [[from.lat, from.lon], [to.lat, to.lon]] };
    try {
      const r = await calculateRoute(from.lat, from.lon, to.lat, to.lon);
      // Нулевой маршрут = точки вне покрытия OSRM: считаем недостоверным
      if (r.duration_seconds > 0) {
        const coords = r.geometry?.coordinates || [];
        info = {
          seconds: r.duration_seconds,
          // OSRM отдаёт [lon, lat]; прореживаем, иначе файл записи распухает
          path: coords.length > 1 ? thin(coords).map(([lon, lat]) => [lat, lon]) : info.path,
        };
      }
    } catch {
      /* оставляем прямую линию и null */
    }
    this.routeCache.set(key, info);
    return info;
  }

  /** Отрезок стояния курьера на месте. */
  _idle(courier, fromT) {
    if (!this.cfg.record) return;
    this.timeline.push({
      c: courier.id,
      t0: fromT,
      t1: null, // закроется при следующем событии
      at: [courier.lat, courier.lon],
    });
  }

  _closeIdle(courierId, atT) {
    if (!this.cfg.record) return;
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const seg = this.timeline[i];
      if (seg.c === courierId && seg.t1 === null) {
        seg.t1 = atT;
        return;
      }
    }
  }

  /** Освободить курьеров, у которых закончился заказ. */
  async releaseFinished() {
    const { db } = this.cfg;
    for (const c of this.couriers) {
      if (c.busyUntil !== null && c.busyUntil <= this.now) {
        c.busyUntil = null;
        // Курьер завершает заказ там, куда его привёз маршрут
        await db.sequelize.query(
          `UPDATE couriers_status
              SET has_order = false, last_online_at = NOW(),
                  location = ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
            WHERE courier_id = :cid`,
          { replacements: { cid: c.id, lon: c.lon, lat: c.lat } }
        );
        this.metrics.delivered();
        this._idle(c, this.now);
      }
    }
  }

  /** Поддерживать last_online_at свежим: иначе сработает фильтр окна онлайна. */
  async refreshOnline() {
    const { db } = this.cfg;
    const free = this.couriers.filter((c) => c.busyUntil === null).map((c) => c.id);
    if (free.length === 0) return;
    await db.sequelize.query(
      `UPDATE couriers_status SET last_online_at = NOW() WHERE courier_id IN (:ids)`,
      { replacements: { ids: free } }
    );
  }

  /** Обработать ответы курьеров на активные приглашения. */
  async resolveInvites() {
    const { db, inviteTtlSeconds } = this.cfg;
    const still = [];

    for (const invite of this.invites) {
      if (this.now < invite.respondAt) {
        // Приглашение ещё «в пути» — ждём
        if (this.now - invite.sentAt < inviteTtlSeconds) still.push(invite);
        else {
          this.metrics.timedOut();
          // Рейтинг считает настоящий модуль: иначе стенд мерил бы копию
          await recordInvitationResponse(invite.courier.id, 'timeout');
          invite.order.rejectedBy.push(invite.courier.id);
          this.orders.push(invite.order);
          invite.courier.busyUntil = null;
          await this.setBusy(invite.courier.id, false);
        }
        continue;
      }

      if (invite.action === 'accept') {
        if (this.cfg.record) {
          const startedAt = this.now;
          const atPickup = startedAt + invite.pickupEta;
          this._closeIdle(invite.courier.id, startedAt);
          this.timeline.push({
            c: invite.courier.id,
            t0: startedAt,
            t1: atPickup,
            path: invite.pathToPickup,
            leg: 'pickup',
          });
          this.timeline.push({
            c: invite.courier.id,
            t0: atPickup,
            t1: startedAt + invite.tripSeconds,
            path: invite.pathToDropoff,
            leg: 'dropoff',
          });
          const rec = this.orderLog.find((o) => o.id === invite.order.id);
          if (rec) {
            rec.assignedT = startedAt;
            rec.doneT = startedAt + invite.tripSeconds;
            rec.courier = invite.courier.id;
          }
        }

        invite.courier.lat = invite.dropoff.lat;
        invite.courier.lon = invite.dropoff.lon;
        invite.courier.busyUntil = this.now + invite.tripSeconds;
        await recordInvitationResponse(
          invite.courier.id,
          'accept',
          this.now - invite.sentAt
        );
        this.metrics.accepted({
          courierId: invite.courier.id,
          pickupEtaSeconds: invite.pickupEta,
          waitSeconds: this.now - invite.order.createdAt,
        });
      } else {
        this.metrics.rejected();
        await recordInvitationResponse(invite.courier.id, 'reject');
        invite.order.rejectedBy.push(invite.courier.id);
        this.orders.push(invite.order);
        invite.courier.busyUntil = null;
        await this.setBusy(invite.courier.id, false);
      }
    }

    this.invites = still.filter((i) => this.now < i.respondAt);
  }

  async setBusy(courierId, busy) {
    await this.cfg.db.sequelize.query(
      `UPDATE couriers_status SET has_order = :busy WHERE courier_id = :cid`,
      { replacements: { cid: courierId, busy } }
    );
  }

  /** Разослать приглашения по ожидающим заказам. */
  async dispatch() {
    const remaining = [];

    for (const order of this.orders) {
      // Сколько кандидатов реально было у формулы: findBestCourier берёт топ-5
      // по дистанции. Если кандидат один, стратегия подбора ни на что не влияет.
      const nearby = await findNearbyCouriers(
        order.pickup.lat,
        order.pickup.lon,
        10000,
        order.rejectedBy
      );
      this.metrics.candidates(Math.min(nearby.length, 5));

      const best = await findBestCourier(
        order.pickup.lat,
        order.pickup.lon,
        order.rejectedBy,
        { score: this.cfg.score || defaultScore }
      );

      if (!best) {
        this.metrics.noCourierAvailable();
        remaining.push(order);
        continue;
      }

      const courier = this.couriers.find((c) => c.id === best.courier_id);
      if (!courier || courier.busyUntil !== null) {
        remaining.push(order);
        continue;
      }

      // Резервируем курьера сразу — аналог invite_lock в воркере
      courier.busyUntil = Infinity;
      await this.setBusy(courier.id, true);

      const pickupEta = best.duration_seconds;
      const legTwo = (await this.routeInfo(order.pickup, order.dropoff)).seconds ?? 0;

      // Трассы нужны только проигрывателю
      let pathToPickup = null;
      let pathToDropoff = null;
      if (this.cfg.record) {
        pathToPickup = (await this.routeInfo({ lat: best.lat, lon: best.lon }, order.pickup)).path;
        pathToDropoff = (await this.routeInfo(order.pickup, order.dropoff)).path;
      }
      const [thinkMin, thinkMax] = courier.profile.thinkSeconds;
      const roll = this.random();

      const action =
        roll < courier.profile.ignore
          ? 'ignore'
          : roll < courier.profile.ignore + courier.profile.accept
            ? 'accept'
            : 'reject';

      this.metrics.invited();
      this.invites.push({
        order,
        courier,
        dropoff: order.dropoff,
        pickupEta,
        tripSeconds: pickupEta + legTwo,
        sentAt: this.now,
        pathToPickup,
        pathToDropoff,
        // Игнор = ответа не будет никогда, сработает таймаут
        respondAt: action === 'ignore' ? Infinity : this.now + this.between(thinkMin, thinkMax),
        action,
      });
    }

    this.orders = remaining;
  }

  async run(onTick) {
    const { durationHours, tickSeconds } = this.cfg;
    const totalTicks = Math.round((durationHours * 3600) / tickSeconds);

    for (let tick = 0; tick < totalTicks; tick++) {
      this.now = tick * tickSeconds;

      await this.releaseFinished();
      await this.refreshOnline();
      await this.resolveInvites();
      this.spawnOrders();
      await this.dispatch();

      if (onTick && tick % 50 === 0) onTick(tick, totalTicks, this.metrics);
    }

    return this.metrics;
  }
}

module.exports = { World, PROFILES };
