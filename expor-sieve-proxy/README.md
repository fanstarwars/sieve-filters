# expor-sieve-proxy

Тонкий аутентифицирующий middleware между плагином `expor-sieve`
(Thunderbird/Mailbird) и REST API mailcow. Mailcow `X-API-Key` имеет только
две градации (ro/rw) и всегда выдаёт `role=admin` без per-mailbox ограничений
(см. [TZ-middleware.md §0](../TZ-middleware.md)). Раздавать его сотрудникам
через managed-config — то же самое, что раздать root-доступ к серверу почты.

Этот сервис делает три вещи:

1. Аутентифицирует пользователя его собственным mailcow-паролем через
   IMAP-bind в Dovecot — ничего не хранит на диске.
2. Whitelist'ит ровно 5 эндпоинтов, нужных плагину
   (`get/mailbox`, `get/filters`, `add/filter`, `edit/filter`, `delete/filter`).
3. Проверяет, что запрос относится к ящику самого юзера, и подставляет
   admin `X-API-Key` уже после авторизации, **внутри своего контейнера**.

Admin-ключ никогда не покидает периметр сервера mailcow.

### Что нового в 0.3.0

- **Auth-кэш TTL урезан с 300с до 60с.** После смены пароля юзера старый
  пароль перестаёт проходить максимум через минуту. При успешном bind с
  новым паролем все старые записи этого юзера сразу выкидываются из кэша
  (eager invalidation), не дожидаясь TTL.
- **F2B-федерация в mailcow netfilter.** При провале IMAP-bind middleware
  публикует событие в Redis-канал `F2B_CHANNEL` в формате, который
  ожидает netfilter mailcow (regex `mailcow UI: Invalid password for .+
  by ([0-9a-f\.:]+)`). С реальным IP клиента, не с IP middleware-
  контейнера. Это закрывает дырку, по которой атакующий через
  `/sieve-proxy/` оставался иммунным к F2B mailcow. Конфигурируется
  переменными `REDIS_URL`, `F2B_ENABLED`, `F2B_CHANNEL`.

## Документация

- Полное ТЗ: [`../TZ-middleware.md`](../TZ-middleware.md).
- Чек-лист админа (prereqs, troubleshooting): [`DEPLOYMENT.md`](DEPLOYMENT.md).
- ТЗ плагина: [`../TZ.md`](../TZ.md).

## Установка на mailcow-сервер

**Требуется:** Docker Compose v2, доступ root (sudo), уже установленный
mailcow-dockerized (по умолчанию `/docker/mailcow-dockerized`; путь
переопределяется через `MAILCOW_DIR=...`).

### Шаг 1 — создайте API-ключ в mailcow

mailcow UI → Configuration → Access → API → **+ Create new API access**:

- Permission: **Read-Write (RW)**.
- IP allow-list: добавьте подсеть `172.22.1.0/24` **и** `fd30:174e:e0e9:1::/64`
  (это subnet `mailcow-network`, в которой будет жить наш контейнер).
- Альтернатива: включить чекбокс **`Skip IP check`** (менее безопасно, но
  работает в любой топологии).

Ключ показывается **один раз** — скопируйте его сразу.

### Шаг 2 — запустите installer

**Из cloned source:**
```sh
git clone <repo-url> /tmp/esp
cd /tmp/esp
sudo MAILCOW_API_KEY="<вставленный ключ>" ./install.sh
```

**Curl-pipe (когда репо опубликован):**
```sh
curl -fsSL https://raw.githubusercontent.com/fanstarwars/expor-sieve-proxy/main/install.sh \
  | sudo MAILCOW_API_KEY="<ключ>" bash
```

Installer (~10 шагов): проверяет prereqs, билдит образ из исходников,
проверяет ключ probe-запросом из docker-сети, бекапит
`docker-compose.override.yml`, добавляет туда блок между маркерами
`# >>> EXPOR-SIEVE-PROXY ... >>>`, генерирует `.expor-sieve-proxy.env`
(root:600) с ключом и `REDIS_URL` (с `REDISPASS` из `mailcow.conf`),
кладёт nginx snippet, whitelist'ит подсеть в F2B, поднимает контейнер,
ждёт `/health`, делает `nginx -s reload`, делает публичный smoke
`https://<MAILCOW_HOSTNAME>/sieve-proxy/health`.

После «`Install OK`» middleware доступен по
`https://<ваш-mailcow-hostname>/sieve-proxy/health`.

**Идемпотентен:** повторный запуск ребилдит образ и обновляет блок в
override через маркеры; чужие сервисы в override не трогает.

### Шаг 3 — поставьте плагин в Thunderbird

Скачайте `expor-sieve-X.Y.Z.xpi` с GitHub Releases плагина и установите
в Thunderbird. URL middleware подтянется автоматически из IMAP-настроек
(`https://<imap-host>/sieve-proxy`).

### Откат

```sh
sudo /tmp/esp/uninstall.sh
```

(или из любого clone repo). По умолчанию восстанавливает последний
`docker-compose.override.yml.bak-*`. С `RESTORE_BACKUP=0` — стирает только
наш блок через маркеры, оставляя остальные правки. С `REMOVE_IMAGE=1` —
удаляет также docker-образ.

## Разработка

```sh
# окружение
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

# тесты
pytest -q

# запуск с моками upstream (см. tests/integration/mock_mailcow.py)
./scripts/dev-up.sh

# или напрямую uvicorn (свои env vars)
MAILCOW_API_KEY=dev MAILCOW_API_URL=http://localhost:9000 \
  uvicorn expor_sieve_proxy.main:app --reload
```

Линтер: `ruff check src tests`.

## Smoke-тест прод-инсталляции

```sh
./scripts/smoke.sh https://mail.example.com/sieve-proxy user@example.com password
```

Ожидаются 5 строк `OK:` и финальное `ALL OK`.

## F2B-federation: проверить что работает

```sh
# 1) с любого IP (вне F2B whitelist) сделать пару запросов с заведомо
#    битым паролем:
curl -k -u admin@example.com:wrong https://mail.example.com/sieve-proxy/v1/auth/check
curl -k -u admin@example.com:wrong https://mail.example.com/sieve-proxy/v1/auth/check

# 2) на mail-сервере убедиться, что netfilter увидел пуши:
docker logs --since=1m mailcowdockerized-netfilter-mailcow-1 | grep "Invalid password"
docker logs --since=1m mailcowdockerized-expor-sieve-proxy-1 | grep f2b.published

# 3) счётчик F2B по IP — в Redis:
docker exec mailcowdockerized-redis-mailcow-1 redis-cli HGETALL F2B_QUEUE
```

После `AUTH_BRUTEFORCE_THRESHOLD` неудачных попыток с одного IP F2B
mailcow забанит его netfilter-правилом — наравне с IMAP/SMTP/UI каналами.

## Зависимости и совместимость с GPL

- FastAPI (MIT), pydantic (MIT), pydantic-settings (MIT), uvicorn (BSD-3),
  httpx (BSD-3), aioimaplib (MIT/Apache-2.0), redis-py (MIT),
  email-validator (CC0/Unlicense), structlog (Apache-2.0/MIT),
  python-multipart (Apache-2.0).
- Все рантайм-зависимости совместимы с GPL-3.0-or-later.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) file.
