# Discord Radio Bot

Бот для Discord, который подключается к голосовому каналу и воспроизводит музыку из плейлистов.

---

## Установка на ПК (Windows)

### 1. Установи Node.js
Скачай и установи Node.js v18+ с https://nodejs.org

### 2. Установи Visual Studio Build Tools (ОБЯЗАТЕЛЬНО)
@discordjs/opus требует нативную компиляцию. Без этого звук не работает.

От PowerShell **от администратора**:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```
Перезагрузи ПК после установки.

### 3. Скопируй проект
Скопируй всю папку проекта на компьютер.

### 4. Установи зависимости
```powershell
cd "путь\к\проекту"
npm install
npm approve-scripts @discordjs/opus ffmpeg-static
npm rebuild @discordjs/opus
```

### 5. Создай config.json
Создай файл `config.json` в корне проекта:
```json
{
  "token": "ТВОЙ_ТОКЕН_БОТА",
  "channelName": "Radio"
}
```

### 6. Получи токен бота
1. Зайди на https://discord.com/developers/applications
2. Нажми "New Application" → дай имя → "Bot" → "Reset Token" → скопируй
3. Вставь токен в config.json

### 7. Настрой права бота
1. На странице приложения → "OAuth2" → "URL Generator"
2. Scopes: `bot`, `applications.commands`
3. Bot Permissions: `Connect`, `Speak`, `Send Messages`
4. Скопируй URL → открой в браузере → добавь бота на сервер
5. **Важно:** При добавлении включи "Applications Commands" scope

### 8. Включи привилегированные интенты
На странице бота → "Bot" → "Privileged Gateway Intents" → включи:
- **Server Members Intent** (может потребоваться)

### 9. Запусти
```powershell
npm start
```

---

## Команды бота

### Основные
| Команда | Описание |
|---------|----------|
| `/panel` | Открыть панель управления с кнопками |
| `/nowplaying` | Показать текущий трек |
| `/add file:...` | Загрузить файл в плейлист |
| `/addurl url:...` | Скачать файл по ссылке в плейлист |
| `/createplaylist name:...` | Создать новый плейлист |
| `/deleteplaylist name:...` | Удалить плейлист |

### Параметры команды /add и /addurl
| Параметр | Обязательный | Описание |
|----------|-------------|----------|
| `file` / `url` | Да | Файл или ссылка |
| `playlist` | Нет | Название плейлиста (по умолчанию текущий) |

Пример: `/addurl url:https://example.com/song.mp3 playlist:chill`

### Панель управления (/panel)
Кнопки на панели:
- ◀◀ — предыдущий трек
- ⏹ — остановить воспроизведение
- ▶ — запустить / подключиться к каналу
- ⏸ — пауза
- ▶▶ — следующий трек
- 🔁 Loop — вкл/выкл зацикливание
- 🔄 Refresh — обновить панель

Выпадающие списки:
- Выбор трека из текущего плейлиста
- Переключение между плейлистами

---

## Структура проекта

```
discord-radio-bot/
├── index.js              # Основной код бота
├── config.json           # Токен бота (НЕ коммитить!)
├── package.json          # Зависимости
├── package-lock.json     # Точная версия зависимостей
├── setup-opus.js         # Скрипт настройки opus
├── .gitignore            # Игнорируемые файлы
├── playlists/            # Плейлисты
│   ├── default/          # Плейлист по умолчанию
│   │   ├── track1.mp3
│   │   └── track2.mp4
│   └── chill/            # Другой плейлист
│       └── song.ogg
└── node_modules/         # Зависимости (НЕ коммитить)
```

---

## Поддерживаемые форматы

| Формат | Аудио | Видео (извлекает звук) |
|--------|-------|----------------------|
| .mp3   | Да    | -                    |
| .ogg   | Да    | -                    |
| .wav   | Да    | -                    |
| .mp4   | -     | Да                   |
| .mkv   | -     | Да                   |
| .webm  | -     | Да                   |

---

## Деплой на хостинг

### Вариант 1: VPS (Railway, Render, DigitalOcean, etc.)

1. **Загрузи проект на сервер:**
```bash
git clone https://github.com/твой-репо.git
cd discord-radio-bot
```

2. **Установи зависимости:**
```bash
npm install
npm approve-scripts @discordjs/opus ffmpeg-static
```

3. **Для @discordjs/opus на Linux нужно:**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y build-essential python3

# CentOS/RHEL
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3
```

4. **Создай config.json:**
```bash
echo '{"token": "ТВОЙ_ТОКЕН", "channelName": "Radio"}' > config.json
```

5. **Запусти:**
```bash
npm start
```

### Вариант 2: Railway.app (бесплатно)

1. Создай аккаунт на https://railway.app
2. Подключи GitHub репозиторий
3. Railway автоматически определит Node.js проект
4. В Settings → Variables добавь:
   - `TOKEN` = твой токен
5. Railway установит зависимости и запустит
6. **Важно:** Railway использует Linux — @discordjs/opus скомпилируется автоматически

### Вариант 3: 24/7 на ПК (PM2)

Если хочешь запускать бота постоянно на своём ПК:

```powershell
npm install -g pm2
pm2 start index.js --name "radio-bot"
pm2 save
pm2 startup
```

Команды PM2:
- `pm2 status` — статус
- `pm2 logs radio-bot` — логи
- `pm2 restart radio-bot` — перезапуск
- `pm2 stop radio-bot` — остановка

---

## Частые проблемы

### Бот не подключается к голосовому каналу
- Проверь что бот имеет права `Connect` и `Speak` на канале
- Убедись что канал ID правильный (в code: `VOICE_CHANNEL_ID`)

### Звук не идёт
- Убедись что установлен Visual Studio Build Tools
- Выполни `npm rebuild @discordjs/opus`
- Проверь что ffmpeg-static установлен: `node -e "console.log(require('ffmpeg-static'))"`

### Slash команды не появляются
- Подожди до 1 часа — Discord кэширует команды
- Проверь что бот добавлен с `applications.commands` scope
- Перезапусти бота

### Ошибка "Used disallowed intents"
- Убери `GuildMembers` интент из кода
- Проверь настройки привилегированных интентов на странице бота

### Бот молчит (показывает "Playing" но звука нет)
- Проблема с шифрованием Discord
- Убедись что используешь `@discordjs/voice@^0.19.2` и `libsodium-wrappers`
- Попробуй `npm rebuild`

---

## Полезные ссылки

- Discord Developer Portal: https://discord.com/developers
- discord.js документация: https://discord.js.org
- @discordjs/voice: https://discord.js.org/#/docs/voice
