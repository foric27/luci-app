# luci-app-modemband

Интерфейс LuCI на JavaScript для пакета `modemband` в OpenWrt и ImmortalWrt 24.10. Приложение предоставляет веб-интерфейс для проверки состояния модема, просмотра информации о SIM-карте и сотовой сети, а также управления предпочитаемыми диапазонами LTE/5G для поддерживаемых модемов 4G/5G.

## Возможности

- JS-страницы LuCI в разделе `Модем → Настройка модема`.
- Обзор модема в реальном времени: производитель, модель, ревизия, IMEI, состояние, режим питания и основной AT-порт.
- Отображение оператора, регистрации, обслуживающей соты, региона, уровня сигнала, RSRP, RSRQ, SINR, TAC, CID, PCI и ARFCN.
- Сбор температуры и напряжения модуля через AT-команды, если модем их поддерживает.
- Карточка информации о SIM-карте: состояние, ICCID, IMSI, EID, оператор, тип SIM и экстренные номера.
- Страницы выбора диапазонов LTE, 5G SA и 5G NSA на основе утилиты `modemband`.
- Страница настроек поведения при перезапуске WAN и модема, AT-команды перезапуска, порта связи и выбора шаблона модема.
- Оформление в светлой и тёмной теме, совместимое с Argon, для страниц LuCI OpenWrt 24.10.
- Файл перевода на упрощённый китайский в `po/zh_Hans/modemband.po`; русский перевод — в `po/ru/modemband.po`.

## Структура пакета

```text
luci-app-modemband/
├── Makefile
├── htdocs/luci-static/resources/view/modem/
│   ├── overview.js
│   ├── blte.js
│   └── blteconfig.js
├── root/etc/config/modemband
├── root/etc/uci-defaults/
│   ├── setupmb.sh
│   └── set_up_bandz.sh
├── root/usr/bin/loaded.sh
├── root/usr/share/luci/menu.d/luci-app-modemband.json
├── root/usr/share/rpcd/acl.d/luci-app-modemband.json
├── root/usr/share/modemband/probeport.gcom
└── po/
    ├── pl/modemband.po
    ├── ru/modemband.po
    └── zh_Hans/modemband.po
```

## Зависимости

Пакет объявляет следующую зависимость LuCI:

```make
LUCI_DEPENDS:=+modemband
```

Страница обзора может использовать следующие утилиты, если они есть и разрешены ACL rpcd:

- `/usr/bin/modemband.sh`
- `/usr/bin/loaded.sh`
- `/usr/bin/mmcli`
- `/usr/bin/sms_tool`

Для данных в реальном времени рекомендуется `ModemManager`. Без него страница всё равно загрузится, но некоторые поля состояния могут показывать `--` или состояние «недоступно».

## Источники информации о SIM

Карточка SIM-карты получает данные из двух источников:

1. Объект SIM в ModemManager через `mmcli -i <sim-index> -J`, если модем предоставляет путь к SIM.
2. Резервный вариант через AT-команды с помощью `sms_tool`:
   - `AT+CPIN?` — состояние PIN или готовность SIM.
   - `AT+QCCID` и `AT+CCID` — ICCID.
   - `AT+CIMI` — IMSI.

Если модем сообщает `sim-missing`, карточка явно показывает `SIM-карта не обнаружена`, а не оставляет область пустой. Если SIM вставлена, но ICCID или IMSI остаются пустыми, проверьте правильность выбранного AT-порта и то, что прошивка модема разрешает эти AT-команды.

## Сборка

Из дерева сборки OpenWrt с установленным LuCI feed:

```sh
./scripts/feeds update luci
./scripts/feeds install luci-app-modemband
make package/luci-app-modemband/compile V=s
```

Для сборки полного образа выберите или включите пакет обычным способом в конфигурации OpenWrt buildroot.

## Установка

Установите собранный пакет на роутер:

```sh
# OpenWrt / ImmortalWrt 25.12 (пакеты из этого репозитория)
apk add --allow-untrusted luci-app-modemband_*.apk

# OpenWrt 24.10 при локальной сборке
opkg install luci-app-modemband_*.ipk
```

После установки при необходимости очистите кэши LuCI и rpcd:

```sh
rm -rf /tmp/luci-modulecache
rm -f /tmp/luci-indexcache
/etc/init.d/rpcd reload
```

Страница доступна по адресу:

```text
Меню: Модем > Настройка модема
Путь LuCI: /cgi-bin/luci/admin/modem/luci-app-modemband/overview
```

## Настройка

Раздел UCI по умолчанию хранится в `/etc/config/modemband`:

```text
config modemband
        option iface 'wan'
        option wanrestart '0'
        option modemrestart '0'
        option notify '0'
```

Основные параметры управляются со страницы настроек LuCI:

- Имя интерфейса WAN, используемого для перезапуска соединения.
- Перезапускать ли WAN после применения изменений диапазонов.
- Перезапускать ли модем после применения изменений диапазонов.
- Необязательная AT-команда для перезапуска модема.
- AT-порт связи, используемый приложением.
- Шаблон модема, назначенный текущим USB Vendor и Product ID.

## Проверка на роутере

Используйте эти команды на роутере для проверки окружения:

```sh
mmcli -L -J
mmcli -m 0 -J
mmcli -m 0 --location-get -J
sms_tool -d /dev/ttyUSB2 at 'AT+CPIN?'
sms_tool -d /dev/ttyUSB2 at 'AT+QCCID'
sms_tool -d /dev/ttyUSB2 at 'AT+CIMI'
```

Замените `/dev/ttyUSB2` на AT-порт, указанный в приложении, если ваш модем использует другой порт.

## Проверка

Для проверки синтаксиса фронтенда во время разработки:

```sh
node --check htdocs/luci-static/resources/view/modem/overview.js
node --check htdocs/luci-static/resources/view/modem/blte.js
node --check htdocs/luci-static/resources/view/modem/blteconfig.js
```

Рекомендуемые ручные проверки после установки или горячего развёртывания изменений:

- Откройте страницу «Обзор» и убедитесь, что карточка модема отображается.
- Убедитесь, что карточка SIM показывает найденные данные или явное состояние отсутствия SIM.
- Убедитесь, что поля сигнала, температуры, напряжения, региона и обслуживающей соты не блокируют отрисовку страницы, если команда бэкенда недоступна.
- Откройте «Настройки диапазонов» и проверьте корректную загрузку выбранных диапазонов LTE/5G.
- Откройте «Настройка» и проверьте, что AT-порт и параметры перезапуска сохраняются.

## Примечания

- Приложение рассчитано на JavaScript-страницы OpenWrt и LuCI 24.10.
- Права ACL намеренно ограничены инструментами и путями, которые нужны интерфейсу.
- Некоторые поля модема зависят от поддержки прошивки. При отсутствии AT-поддержки должно отображаться `--` или состояние «недоступно», а не блокировка страницы LuCI.
- Если после развёртывания LuCI продолжает показывать старый фронтенд, очистите `/tmp/luci-modulecache`, удалите `/tmp/luci-indexcache` и принудительно обновите кэш браузера.
