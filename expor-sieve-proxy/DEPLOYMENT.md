# DEPLOYMENT.md — чек-лист администратора

Развёртывание `expor-sieve-proxy` рядом со штатным compose-стеком mailcow.
Один скрипт `install.sh` делает всё; этот документ — для тех, кто хочет
понимать, что именно происходит, и иметь под рукой troubleshooting.

## 0. Prereqs

- [ ] Запущенный mailcow (compose v2): `docker compose ps` показывает
      `nginx-mailcow`, `php-fpm-mailcow`, `dovecot-mailcow`, `redis-mailcow`,
      `netfilter-mailcow` в статусе `running`.
- [ ] Каталог установки mailcow известен (по умолчанию `/docker/mailcow-dockerized`).
      Если иной — экспортируйте `MAILCOW_DIR=/path/to/mailcow-dockerized`.
- [ ] Доступ к web-UI mailcow с правами админа.
- [ ] Доступ к серверу по SSH с правом `sudo`.
- [ ] На сервере есть `git`, `docker`, `docker compose`, `curl`.
- [ ] `MAILCOW_HOSTNAME` (внешнее DNS-имя mailcow) резолвится — `install.sh`
      использует его для финального публичного smoke-запроса.

## 1. Создать API-ключ mailcow

- [ ] Login → System → Configuration → Access → API → **+ Create new API access entry**.
- [ ] **Permission:** Read-Write (RW).
- [ ] **Allow API access for these IP-Ranges:** `172.22.1.0/24` (дефолтный
      subnet `mailcow-network`) **и** `fd30:174e:e0e9:1::/64`.
      Альтернатива — чекбокс **`skip_ip_check`** (менее безопасно).
- [ ] Сохранить ключ — он показывается **один раз**.

> Если этот шаг пропустить, mailcow будет отвечать
> `401 api access denied for ip 172.22.1.x`, и `install.sh` упадёт на
> probe-стадии с подсказкой про IP-ACL.

## 2. Запустить installer

```sh
git clone <repo-url> /tmp/esp
cd /tmp/esp
sudo MAILCOW_API_KEY="<ключ>" ./install.sh
```

Что делает скрипт по шагам:

- [ ] Self-elevate под root, если запущен без sudo.
- [ ] Pre-flight: docker, compose, наличие `$MAILCOW_DIR`/mailcow.conf.
- [ ] Резолв API-ключа: `MAILCOW_API_KEY` env → интерактивный hidden prompt
      (если есть TTY) → fail если `NONINTERACTIVE=1`.
- [ ] Резолв source: текущая директория, если есть `Dockerfile` рядом;
      иначе `git clone` в `/tmp/esp-build/`.
- [ ] `docker build -t expor-sieve-proxy:latest -t :<version>`.
- [ ] Probe API-ключа из контейнера nginx-mailcow (вернёт ли mailcow JSON
      с `version`).
- [ ] Бекап `docker-compose.override.yml` → `.bak-<UTC-timestamp>`.
- [ ] Patch override: блок между маркерами `# >>> EXPOR-SIEVE-PROXY ... >>>`,
      heredoc внутри install.sh — никаких отдельных fragment-файлов
      редактировать не нужно.
- [ ] Запись `.expor-sieve-proxy.env` (root:600) с `MAILCOW_API_KEY` и
      `REDIS_URL=redis://:<REDISPASS>@redis:6379/0` (REDISPASS из
      mailcow.conf — нужен для F2B-federation).
- [ ] Копия `conf/nginx-site.sieve-proxy.custom` →
      `data/conf/nginx/site.sieve-proxy.custom`.
- [ ] F2B whitelist: `redis-cli HSET F2B_WHITELIST 172.22.1.0/24 1` +
      `pkill -HUP -f main.py` netfilter'а.
- [ ] `docker compose up -d expor-sieve-proxy`.
- [ ] Wait-for `/health` (до 30с).
- [ ] `nginx -t && nginx -s reload`.
- [ ] Публичный smoke `GET https://<MAILCOW_HOSTNAME>/sieve-proxy/health`.
- [ ] Печать install summary с путями и командами для отката.

## 3. Поставить плагин в Thunderbird

- [ ] Скачать `expor-sieve-X.Y.Z.xpi` из GitHub Releases плагина.
- [ ] Thunderbird → Add-ons → Install Add-on From File → выбрать `.xpi`.
- [ ] URL middleware (`https://<imap-host>/sieve-proxy`) плагин подтянет
      автоматически из IMAP-настроек.

## 4. Smoke-тест от админа

```sh
./scripts/smoke.sh https://mail.example.com/sieve-proxy user@example.com password
```

Ожидаются 5 строк `OK:` и финальное `ALL OK`.

## 5. Troubleshooting

### `/sieve-proxy/health` отдаёт 502

- [ ] `docker compose ps expor-sieve-proxy` — должен быть `Up (healthy)`.
- [ ] `docker logs --tail=50 mailcowdockerized-expor-sieve-proxy-1`.
- [ ] Проверьте, что контейнер реально в `mailcow-network`:
      ```sh
      docker inspect mailcowdockerized-expor-sieve-proxy-1 \
        --format '{{json .NetworkSettings.Networks}}' | jq .
      ```
- [ ] Изнутри контейнера nginx: `curl -v http://sieve-proxy:8000/health`
      должен отвечать 200.

### `502 upstream auth denied (check IP-ACL)`

- [ ] Шаг 1 не выполнен или сделан с неправильной подсетью. Проверьте в UI
      `Configuration → Access → API`, что у ключа `allow_from` содержит
      `172.22.1.0/24` (или включён `skip_ip_check`).
- [ ] После правки в UI достаточно не делать ничего — следующий запрос
      пойдёт уже с обновлённым ACL.

### F2B-publish не работает (атакующий не банится)

- [ ] `docker logs --since=5m mailcowdockerized-expor-sieve-proxy-1 | grep f2b`
      — должно быть `f2b.published` после неудачных попыток.
- [ ] Проверьте, что `REDIS_URL` в `.expor-sieve-proxy.env` содержит пароль:
      ```sh
      sudo grep REDIS_URL /docker/mailcow-dockerized/.expor-sieve-proxy.env
      ```
      Должно быть `redis://:<REDISPASS>@redis:6379/0`.
- [ ] Проверьте, что подсеть `172.22.1.0/24` есть в whitelist'е:
      ```sh
      docker exec mailcowdockerized-redis-mailcow-1 redis-cli HGETALL F2B_WHITELIST
      ```
- [ ] netfilter mailcow видит наши события:
      ```sh
      docker logs --since=5m mailcowdockerized-netfilter-mailcow-1 | grep "Invalid password"
      ```

### Контейнер `crashloop`, в логах `MAILCOW_API_KEY is required`

- [ ] `.expor-sieve-proxy.env` не подцеплен. Проверьте:
      ```sh
      sudo ls -l /docker/mailcow-dockerized/.expor-sieve-proxy.env
      sudo cat /docker/mailcow-dockerized/.expor-sieve-proxy.env  # должно быть 2 строки
      ```
- [ ] И что в override-блоке есть `env_file: - ./.expor-sieve-proxy.env`.

### Сменить API-ключ

```sh
sudo MAILCOW_API_KEY="<новый-ключ>" /tmp/esp/install.sh
```

Installer перезапишет env-файл и рестартует контейнер. Старый ключ можно
удалить в UI mailcow.

### Поднять `RATE_LIMIT_PER_MIN` или `REQUEST_TIMEOUT`

Добавьте/измените в `environment:` блока override (между маркерами в
`docker-compose.override.yml`) и сделайте `docker compose up -d
expor-sieve-proxy`. Если хотите чтобы изменение пережило `install.sh`-rerun
— после правки скопируйте обновлённый блок в heredoc внутри `install.sh`.

## 6. Логи и audit

JSON-логи идут в stdout контейнера:

```sh
docker compose logs -f expor-sieve-proxy
```

Audit-события write-операций:

```json
{"event":"audit.filter_added","user":"ivan@example.com","script_desc":"…",…}
```

Только audit:
```sh
docker compose logs expor-sieve-proxy | grep audit\.
```

Долгое хранение / централизация — на стороне заказчика (rsyslog, loki,
elastic — что угодно, читающее stdout docker-контейнера).

## 7. Обновление до новой версии

```sh
cd /tmp/esp && git pull
sudo MAILCOW_API_KEY="<тот же ключ>" ./install.sh
```

Installer ребилдит образ из свежего source, обновляет блок в override
через маркеры, перезапускает только `expor-sieve-proxy`. Mailcow в целом
не трогается, downtime измеряется секундами.

Кэш аутентификации сбросится; в худшем случае юзеру придётся ввести
пароль ещё раз (плагин это уже умеет).

## 8. Откат

```sh
sudo /tmp/esp/uninstall.sh
```

По умолчанию (`RESTORE_BACKUP=1`) восстанавливает последний
`docker-compose.override.yml.bak-*`. Иначе стирает только наш блок
через маркеры. F2B whitelist подсети остаётся (не вреден, но если
хочется убрать — последнюю команду в выводе uninstall'а).

Никаких персистентных данных middleware не оставляет.

## 9. Security рекомендации

- **Никогда** не коммитьте `.expor-sieve-proxy.env` в git. Файл создан
  с правами `root:root 600`.
- API-ключ должен быть RW и иметь IP-ACL; раздавать его в UI как админский
  ключ для людей — нельзя (см. `../TZ-middleware.md §0`).
- Если меняли в админке mailcow IP-ACL ключа — проверьте, что
  `172.22.1.0/24` (и v6 аналог) не пропали.
- `nginx-site.sieve-proxy.custom` отдаёт 404 при отсутствии mailcow-нгинкса
  по дефолту; ничего наружу без mailcow nginx опубликовано не будет.
- Логируется только `event=`, `user=`, `path=`. Тела фильтров и пароли
  никогда не пишутся в логи.
