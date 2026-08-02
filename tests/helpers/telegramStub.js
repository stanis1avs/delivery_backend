// Локальный стаб Telegram Bot API.
//
// Прогон не должен ходить в api.telegram.org: это медленно, требует сети и
// настоящего токена. Подменяем адрес через TELEGRAM_API_URL (опция baseApiUrl
// библиотеки) и заодно получаем возможность проверить, что именно отправлено —
// текст уведомления и inline-кнопки.

const http = require('node:http');
const querystring = require('node:querystring');

/**
 * Тело запроса → объект. node-telegram-bot-api шлёт form-urlencoded, а не JSON,
 * причём вложенные структуры (reply_markup) внутри формы лежат JSON-строкой.
 */
function parseBody(contentType, body) {
  if (!body) return {};

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  }

  const form = querystring.parse(body);
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === 'string' && /^[[{]/.test(value.trim())) {
      try {
        form[key] = JSON.parse(value);
      } catch {
        /* оставляем строкой */
      }
    }
  }
  return form;
}

/**
 * Поднять стаб и направить на него бота через TELEGRAM_API_URL.
 * Вызывать ДО первого импорта воркера: клиент создаётся при загрузке модуля.
 */
async function startTelegramStub() {
  const previousUrl = process.env.TELEGRAM_API_URL;
  const sent = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // Путь вида /bot{token}/sendMessage — нас интересует имя метода
      const method = req.url.split('/').pop().split('?')[0];
      const payload = parseBody(req.headers['content-type'] || '', body);
      sent.push({ method, payload });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${server.address().port}`;

  return {
    /** Все запросы к Bot API за время жизни стаба. */
    sent,
    /** Только отправленные сообщения. */
    messages: () => sent.filter((s) => s.method === 'sendMessage'),
    clear: () => {
      sent.length = 0;
    },
    async close() {
      if (previousUrl === undefined) delete process.env.TELEGRAM_API_URL;
      else process.env.TELEGRAM_API_URL = previousUrl;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startTelegramStub };
