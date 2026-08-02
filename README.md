# Delivery

Проект сервиса доставки — приложение для курьеров. За основу взят [макет Figma](https://www.figma.com/design/cZ3pCVoUAQUSqmNyXH1PtN/Delivery-Service-Dashboard---Admin-Panel--Community-?node-id=0-1&p=f&t=3kIzuy2rIRglQLOK-0).

[Функционал приложения](https://github.com/stanis1avs/delivery_frontend/blob/master/FUNCTIONAL.md)


### Основная функциональность:
- Авторизация через Telegram Login Widget
- Real-time трекинг геопозиции курьеров (Geolocation API → PostGIS)
- Назначение заказов ближайшему свободному курьеру (ST_DWithin + рейтинг)
- Расчёт маршрута и времени доставки через OSRM
- Интерактивная карта с маршрутом и маркерами курьеров (Leaflet)
- Уведомления курьеру через Telegram Bot с подтверждением заказа
- Real-time обновления заказов и позиций на карте (WebSocket / Socket.IO)
- Система надёжности курьера: рейтинг, выполненные заказы, среднее время принятия


## Технический стек frontend-приложения:

1. Nuxt 3 + Vue 3
2. SCSS
3. Telegram Auth API
4. Socket.IO Client
5. Leaflet + OpenStreetMap - Интерактивная карта     

## Технический стек backend-приложения:

1. Express.js
2. PostgreSQL + PostGIS 
3. Sequelize
4. OSRM
5. Redis
6. Telegram Bot API
7. Socket.IO
8. _Kafka  (в разработке)_
9. _Google Text-to-Speech API (в разработке)_ - Голосовые уведомления в Telegram
10. _TensorFlow.js K-Means (в разработке)_ - расчет скоростей доставки

---

## Redis: точки роста

### Транзакции (MULTI / EXEC)
При принятии или отклонении заказа выполняется несколько Redis-операций подряд (`GET pending_courier` → `DEL` → `HSET courier:status`). Между ними другой воркер может назначить тот же заказ второму курьеру. Решение — обернуть операции в `multi().exec()`, чтобы они выполнились атомарно.

### Distributed Lock (SETNX)
`pending_courier:{orderId}` создаётся через обычный `SET`, что не гарантирует эксклюзивного доступа под нагрузкой. Паттерн SET NX (set if not exists) или библиотека `redlock` решают задачу: первый воркер получает блокировку, остальные — `null` и пропускают заказ.

### SCAN вместо KEYS *
В `choose_courier.js` используется `KEYS courier:*:status` как fallback. `KEYS` блокирует Redis на время выполнения — при большом количестве ключей это заморозит весь сервер. Замена: итеративный `SCAN` с курсором, который работает постепенно и не блокирует event loop.

### Redis Streams — лог событий заказов
Каждое изменение заказа (`created → assigned → accepted → delivered`) можно писать в Stream: `XADD order:events * action accepted orderId 42`. Это даёт полную историю жизни заказа, возможность воспроизвести события и основу для будущей аналитики доставки.
