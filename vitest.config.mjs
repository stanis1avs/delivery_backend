import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Имя берём из общего модуля, а не литералом: globalSetup читает его же,
// и разъехаться они не могут (см. комментарий в tests/setup/testDbName.cjs)
const require = createRequire(import.meta.url);
const TEST_DB = require('./tests/setup/testDbName.cjs');

export default defineConfig({
  test: {
    // Тесты ходят в ОТДЕЛЬНУЮ базу, чтобы не задеть рабочие данные.
    // Значение попадает в process.env воркеров раньше загрузки модулей, а dotenv
    // по умолчанию не перезаписывает уже заданные переменные — поэтому остальные
    // DB_* подтянутся из .env, а имя базы останется тестовым.
    env: {
      DB_NAME: TEST_DB,
    },
    globalSetup: ['./tests/setup/globalSetup.js'],
    setupFiles: ['./tests/setup/loadEnv.js'],
    include: ['tests/**/*.test.js'],
    // Тесты делят одну базу, параллельные файлы затирали бы фикстуры друг другу
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
