// Один раз перед всем прогоном: создать тестовую базу и накатить на неё миграции.
// Схема поднимается теми же миграциями, что и рабочая, — иначе тесты проверяли бы
// схему, которой нет в проде.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

require('dotenv').config();

const BACKEND_DIR = path.resolve(__dirname, '..', '..');

// Из общего модуля, а НЕ из process.env: в главном процессе vitest переменная
// DB_NAME всё ещё указывает на рабочую базу, а мы её здесь дропаем
const TEST_DB = require('./testDbName.cjs');

async function ensureDatabase() {
  if (!TEST_DB || !TEST_DB.endsWith('_test') || TEST_DB === process.env.DB_NAME) {
    // Страховка от прогона по рабочей базе: ниже DROP DATABASE
    throw new Error(
      `Небезопасное имя тестовой базы: "${TEST_DB}". ` +
        'Ожидается имя на _test, не совпадающее с DB_NAME из .env.'
    );
  }

  // Подключаемся к служебной базе postgres, чтобы управлять тестовой
  const admin = new Client({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: 'postgres',
  });

  await admin.connect();
  try {
    // Пересоздаём с нуля: так проверяется и то, что миграции applied from scratch
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
}

function runMigrations() {
  // Запускаем CLI напрямую через node, а не через npx: на Windows execFileSync
  // не может стартовать .cmd-шим без shell и падает с EINVAL
  const cli = path.join(BACKEND_DIR, 'node_modules', 'sequelize-cli', 'lib', 'sequelize');

  try {
    execFileSync(process.execPath, [cli, 'db:migrate', '--env', 'test'], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DB_NAME: TEST_DB, NODE_ENV: 'test' },
      stdio: 'pipe',
    });
  } catch (err) {
    // stdout/stderr sequelize-cli содержат причину — без них диагностировать нечем
    const details = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n');
    throw new Error(`Миграции тестовой базы не применились:\n${details || err.message}`);
  }
}

module.exports = async function globalSetup() {
  await ensureDatabase();
  runMigrations();
  console.log(`\nТестовая база "${TEST_DB}" создана, миграции применены.`);
};
