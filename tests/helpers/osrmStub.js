// Подменяем OSRM настоящим HTTP-сервером, а не моком axios.
//
// Мок модуля здесь ненадёжен: axios поставляется и в CJS, и в ESM сборке, тесты и
// geo.js могут получить РАЗНЫЕ экземпляры, и подмена молча не сработает. Стаб на
// http-сервере проверяет ещё и реальный сетевой путь — разбор ответа, таймауты.

const http = require('node:http');

/**
 * Поднять стаб OSRM и направить на него geo.js через OSRM_URL.
 *
 * @param {(req) => object|null} respond — что вернуть; null → 500
 * @returns {Promise<{close: () => Promise<void>}>}
 */
async function startOsrmStub(respond) {
  const previousUrl = process.env.OSRM_URL;

  const server = http.createServer((req, res) => {
    const body = respond(req);
    if (body === null) {
      res.writeHead(500).end('stub failure');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OSRM_URL = `http://127.0.0.1:${server.address().port}`;

  return {
    async close() {
      // Восстанавливаем адрес, иначе следующий тест пойдёт в уже закрытый стаб
      if (previousUrl === undefined) delete process.env.OSRM_URL;
      else process.env.OSRM_URL = previousUrl;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Ответ OSRM с фиксированными дистанцией и временем. */
function fixedRoute({ distance = 1000, duration = 300 } = {}) {
  return () => ({
    code: 'Ok',
    routes: [
      {
        distance,
        duration,
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      },
    ],
  });
}

/**
 * Направить geo.js на заведомо закрытый порт — имитация недоступного OSRM.
 * @returns {() => void} восстановление прежнего адреса
 */
function pointToDeadPort() {
  const previousUrl = process.env.OSRM_URL;
  // Порт 1 требует привилегий и никем не слушается → соединение сразу отвергается
  process.env.OSRM_URL = 'http://127.0.0.1:1';
  return () => {
    if (previousUrl === undefined) delete process.env.OSRM_URL;
    else process.env.OSRM_URL = previousUrl;
  };
}

module.exports = { startOsrmStub, fixedRoute, pointToDeadPort };
