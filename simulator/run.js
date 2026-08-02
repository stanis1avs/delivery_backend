#!/usr/bin/env node
// Стенд оценки распределения заказов.
//
//   npm run simulate                       — сравнить стратегии на базовом сценарии
//   npm run simulate -- --couriers 40 --orders-per-hour 120 --hours 4
//   npm run simulate -- --strategy current --seed 7
//
// Работает в ОТДЕЛЬНОЙ базе delivery_sim: прогон создаёт десятки курьеров и
// сотни заказов, в рабочей базе им не место.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SIM_DB = 'delivery_sim';

process.env.DB_NAME = SIM_DB;
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });
process.env.DB_NAME = SIM_DB; // .env не должен перебить, даже если там есть DB_NAME

const { World } = require('./world');
const { writeReplay } = require('./replay');

// ── аргументы ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const CONFIG = {
  // Статен-Айленд: зона покрытия загруженного экстракта OSRM
  center: { lat: 40.5952146, lon: -74.1827119 },
  radiusDeg: parseFloat(args.radius) || 0.03, // ≈ 3 км
  couriers: parseInt(args.couriers, 10) || 20,
  ordersPerHour: parseInt(args.ordersPerHour, 10) || 60,
  durationHours: parseFloat(args.hours) || 2,
  tickSeconds: parseInt(args.tick, 10) || 5, // как у воркера
  inviteTtlSeconds: parseInt(args.inviteTtl, 10) || 300,
  seed: parseInt(args.seed, 10) || 42,
};

// Сколько прогонов на стратегию: результаты усредняются
const REPEAT = parseInt(args.repeat, 10) || 3;

// --record: записать первый прогон каждой стратегии в HTML-проигрыватель.
// Запись требует лишних вызовов OSRM за геометрией, поэтому по умолчанию выключена.
const RECORD = 'record' in args;
const OUT_DIR = path.join(__dirname, 'out');

// ── стратегии подбора ───────────────────────────────────────────────────────

/**
 * Каждая стратегия — функция стоимости кандидата (меньше = лучше).
 * Прогоняются через настоящий findBestCourier, а не через копию логики.
 */
function strategies(world) {
  return {
    // Как в проде сегодня
    current: (c) => c.duration_seconds - (c.rating || 0) * 30,

    // Чистая близость: рейтинг игнорируется
    nearest: (c) => c.duration_seconds,

    // Рейтинг весит вчетверо больше
    'rating-heavy': (c) => c.duration_seconds - (c.rating || 0) * 120,

    // Близость со штрафом за уже выполненный объём — против выгорания топов
    fair: (c) => {
      const done = world.metrics.perCourier.get(c.courier_id) || 0;
      return c.duration_seconds + done * 60;
    },
  };
}

// ── подготовка базы ─────────────────────────────────────────────────────────

async function recreateDatabase() {
  const admin = new Client({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${SIM_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SIM_DB}"`);
  } finally {
    await admin.end();
  }

  execFileSync(
    process.execPath,
    [
      path.join(BACKEND_DIR, 'node_modules', 'sequelize-cli', 'lib', 'sequelize'),
      'db:migrate',
      '--env',
      'test',
    ],
    { cwd: BACKEND_DIR, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe' }
  );
}

async function truncate(db) {
  await db.sequelize.query(
    'TRUNCATE orders, couriers_status, couriers_reliability, couriers, users RESTART IDENTITY CASCADE'
  );
}

// ── вывод ───────────────────────────────────────────────────────────────────

const ROWS = [
  ['Заказов создано', 'orders_created'],
  ['Назначено', 'orders_assigned'],
  ['Доставлено', 'orders_delivered'],
  ['Не назначено', 'orders_unassigned'],
  ['ETA до забора, медиана (с)', 'pickup_eta_median_s'],
  ['ETA до забора, p95 (с)', 'pickup_eta_p95_s'],
  ['Ожидание курьера, медиана (с)', 'wait_median_s'],
  ['Ожидание курьера, p95 (с)', 'wait_p95_s'],
  ['Приглашений на назначение', 'invites_per_assignment'],
  ['Доля отказов', 'rejection_rate'],
  ['Доля игноров', 'timeout_rate'],
  ['Джини по нагрузке', 'load_gini'],
  ['Кандидатов, медиана', 'candidates_median'],
  ['Был выбор, % подборов', 'choice_available_pct'],
  ['Курьеров задействовано', 'couriers_used'],
];

/** Среднее по прогонам: числовые поля усредняются, остальные берутся из первого. */
function average(runs) {
  const out = {};
  for (const key of Object.keys(runs[0])) {
    const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number');
    // Три знака: у Джини и долей отказов различия лежат в сотых
    out[key] = values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000
      : runs[0][key];
  }
  return out;
}

function printComparison(results) {
  const names = Object.keys(results);
  const width = Math.max(...ROWS.map(([label]) => label.length)) + 2;
  const col = 16;

  console.log('');
  console.log('─'.repeat(width + col * names.length));
  console.log('Метрика'.padEnd(width) + names.map((n) => n.padStart(col)).join(''));
  console.log('─'.repeat(width + col * names.length));

  for (const [label, key] of ROWS) {
    const cells = names.map((n) => String(results[n][key] ?? '—').padStart(col));
    console.log(label.padEnd(width) + cells.join(''));
  }
  console.log('─'.repeat(width + col * names.length));
}

// ── запуск ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('Пересоздаю базу симуляции…');
  await recreateDatabase();

  const db = require('../models');
  const results = {};
  const replays = [];

  // Список стратегий строится под каждый мир: fair смотрит на его метрики
  const requested = args.strategy ? [args.strategy] : Object.keys(strategies({ metrics: new Map() }));

  console.log(
    `Сценарий: ${CONFIG.couriers} курьеров, ${CONFIG.ordersPerHour} заказов/час, ` +
      `${CONFIG.durationHours} ч, seed ${CONFIG.seed}\n`
  );

  for (const name of requested) {
    process.stdout.write(`  ${name.padEnd(14)} `);
    const started = Date.now();
    const runs = [];

    // Один прогон — это шум: на нескольких десятках заказов разница в пару секунд
    // ничего не доказывает. Усредняем по нескольким seed'ам.
    for (let r = 0; r < REPEAT; r++) {
      await truncate(db);

      // Пишем только первый прогон: остальные нужны лишь для усреднения чисел
      const world = new World({ db, ...CONFIG, seed: CONFIG.seed + r, record: RECORD && r === 0 });
      const score = strategies(world)[name];
      if (!score) throw new Error(`Неизвестная стратегия: ${name}`);
      world.cfg.score = score;

      await world.spawnFleet();
      await world.run();
      const summary = world.metrics.summary();
      runs.push(summary);
      if (RECORD && r === 0) replays.push(writeReplay(world, name, summary, OUT_DIR));
      process.stdout.write('.');
    }

    results[name] = average(runs);
    console.log(` готово за ${Math.round((Date.now() - started) / 1000)} с`);
  }

  printComparison(results);

  if (replays.length) {
    console.log('');
    console.log('Проигрыватели записи (открыть в браузере):');
    for (const f of replays) console.log('  ' + f);
  }

  console.log('');
  console.log('Метрики сняты на симуляции: они сравнивают стратегии между собой,');
  console.log('а не предсказывают абсолютные значения в проде.');

  await db.sequelize.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
