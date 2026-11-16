# P2P Telegram bot

Скриншот завершённого Binance P2P ордера USDT/UAH → локальный OCR → проверка и подтверждение пользователем → Google Sheets.

Бесплатная схема размещения: Render Web Service + Firestore Spark + HTTP-монитор UptimeRobot. Черновики и очередь сохраняются в Firestore до подтверждения пользователю. Ключи и токены задаются только в настройках сервиса.

## Render

Создай Web Service из этого репозитория. Runtime: Docker. Plan: Free. Health Check Path: /readyz. Параметры также описаны в render.yaml.

Обязательные переменные: TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_IDS, GOOGLE_SPREADSHEET_ID, GOOGLE_SHEET_NAME, GOOGLE_SERVICE_ACCOUNT_FILE, STATE_BACKEND=firestore, FIRESTORE_PROJECT_ID, DATA_DIR=/app/data.

Несколько пользователей ведут отдельные таблицы через USER_SPREADSHEETS_JSON. Подключение новых людей и создание чистого журнала описаны в USERS.md. Каждому ID назначается собственная таблица; общая таблица для разных ID запрещена.

Google-ключ добавляется через Render Secret Files с именем google-service-account.json. GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/google-service-account.json. В GitHub ключ не загружается.

Разреши email сервисного аккаунта редактировать таблицу и выдай Cloud Datastore User в проекте Firestore. Если проект базы отличается от проекта ключа, FIRESTORE_PROJECT_ID должен указывать проект базы.

UptimeRobot: HTTP(s), адрес https://YOUR-SERVICE.onrender.com/healthz, интервал 5 минут. Бесплатные тарифы имеют квоты и не гарантируют непрерывную доступность.

## Проверки и локальный запуск

Требуется Node.js 24. Установка: npm install --ignore-scripts. Проверки: npm test. Локальные настройки: скопировать .env.example в .env и заполнить. Проверка Google: node --env-file=.env scripts/check-google.mjs. Запуск: npm start.

Тестовые примеры OCR обезличены. Личные отчёты, исходные скриншоты, фактические токены, ключи и рабочая база данных в этот репозиторий не входят.
