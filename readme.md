# Сводка по приложениям LuCI

Этот документ описывает пакеты, точки входа в интерфейсе, файлы конфигурации, права доступа, серверные интерфейсы и способы проверки работы приложений LuCI из текущего рабочего каталога. Приложения рассчитаны на совместимость с OpenWrt / LuCI 24.10; готовый репозиторий пакетов собирается для OpenWrt / ImmortalWrt 25.12 в формате `apk`. Учтены требования к совместимости с темами, автоматической сборке и проверке работы из README `luci-app-sfp-status`.

## Быстрая навигация

1. [Обзор приложений](#обзор-приложений)
2. [Репозиторий пакетов](#репозиторий-пакетов)
3. [Общая структура каталогов](#общая-структура-каталогов)
4. [luci-app-fan](#luci-app-fan)
5. [luci-app-modemband](#luci-app-modemband)
6. [luci-app-sfp-status](#luci-app-sfp-status)
7. [Другие пакеты репозитория](#другие-пакеты-репозитория)
8. [Сборка и проверка](#сборка-и-проверка)
9. [Замечания по сопровождению](#замечания-по-сопровождению)

## Обзор приложений

| Приложение | Версия пакета | Назначение | Точка входа LuCI | Основные зависимости |
| --- | --- | --- | --- | --- |
| luci-app-fan | 0.1.2-r4 | Управление вентилятором pwm-fan на BPI-R4 и других устройствах, панель температуры/PWM/оборотов | Статус > Управление вентилятором | luci-base, coreutils-stat |
| luci-app-modemband | 2.0-r23 | Настройка диапазонов модемов 4G/5G, состояние модема, сигнал, сота, информация SIM | Модем > Настройка модема | modemband |
| luci-app-sfp-status | 0.1.0-r31 | Чтение телеметрии DOM SFP/SFP+ и вывод на странице обзора | Статус > Обзор (include) | luci-base, ethtool |

## Репозиторий пакетов

GitHub Actions собирает все пакеты одним workflow и публикует их как готовый OpenWrt-репозиторий на GitHub Pages:

- **apk (OpenWrt / ImmortalWrt 25.12):** `https://foric27.github.io/luci-app/apk`

Версионный псевдоним: `https://foric27.github.io/luci-app/25.12`.

Подключение:

```sh
echo 'https://foric27.github.io/luci-app/apk' >> /etc/apk/repositories
apk update
```

Список репозиториев находится в `/etc/apk/repositories`.

Пример установки после обновления списка:

```sh
apk add --allow-untrusted luci-app-fan luci-i18n-fan-ru
```

Репозиторий обновляется автоматически при сборке. Все пакеты также прикладываются к одному GitHub Release: по тегу `repo-v*`, при ручном запуске с `publish_release=true` или в автоматически обновляемый релиз `packages-latest` при сборке из ветки `main`. Пакеты не подписаны: при установке может потребоваться `--allow-untrusted`.

Один раз включите GitHub Pages: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Общая структура каталогов

Приложения в основном следуют структуре пакетов OpenWrt/LuCI:

| Путь | Назначение |
| --- | --- |
| Makefile | Метаданные пакета OpenWrt, зависимости, postinst-скрипты, объявление conffiles |
| htdocs/luci-static/resources/view/ | JavaScript-страница LuCI или include страницы статуса |
| root/etc/config/ | Конфигурация UCI по умолчанию |
| root/etc/init.d/ | Скрипты служб init, только для приложений-служб |
| root/etc/uci-defaults/ | Инициализация и миграция после установки |
| root/usr/libexec/rpcd/ | Серверные скрипты rpcd, предоставляющие методы ubus |
| root/usr/share/rpcd/acl.d/ | Определения прав ACL LuCI |
| root/usr/share/luci/menu.d/ | Определения пунктов меню LuCI |
| po/ru/ | Русский перевод |
| po/zh_Hans/ | Перевод на упрощённый китайский |

## luci-app-fan

### Информация о пакете Fan

- Имя пакета: `luci-app-fan`
- Версия: 0.1.2-r4
- Архитектура: `all`
- Лицензия: Apache-2.0
- Сопровождающий: MedyMa
- Сохраняемый файл конфигурации: `/etc/config/luci-fan`

### Возможности Fan

- Панель состояния в реальном времени: температура CPU, скважность PWM, обороты вентилятора, текущий режим и состояние службы.
- Режимы управления: `turbo`, `smart`, `manual`.
- Умный режим: автоматический расчёт выхода PWM по `off_temp` / `on_temp`.
- Ручной режим: фиксированная цель PWM по `manual_pwm`.
- Оценка максимальных оборотов: ограничение или оценка отображения RPM по `max_rpm`.
- Быстрые действия в форме: быстро подставить конфигурацию «турбо», «умный» или «ручной», затем сохранить и применить через LuCI.

### Фронтенд-файлы Fan

| Файл | Назначение |
| --- | --- |
| htdocs/luci-static/resources/view/fan.js | Страница управления вентилятором с панелью реального времени и формой UCI |

### Бэкенд и права Fan

- Бэкенд rpcd: `root/usr/libexec/rpcd/luci.fan`
- Объект ubus: `luci.fan`
- Метод только для чтения: `getStatus`
- Права UCI: чтение и запись `luci-fan`
- Вспомогательный скрипт управления: `root/usr/libexec/fan-control`
- Служба init: `root/etc/init.d/luci-fan`
- ACL: `root/usr/share/rpcd/acl.d/luci-app-fan.json`

### Основные параметры UCI Fan

| Параметр | Значение по умолчанию | Описание |
| --- | --- | --- |
| enabled | 0 | Включена ли служба вентилятора |
| mode | smart | Режим управления |
| manual_pwm | 70 | Ручной PWM в процентах |
| on_temp | 60 | Температура повышения оборотов в умном режиме |
| off_temp | 30 | Температура остановки или низких оборотов в умном режиме |
| max_rpm | 3000 | Оценка максимальных оборотов вентилятора |
| poll_interval | 5 | Интервал опроса состояния |

### Скриншот Fan

<img width="1613" height="1358" alt="image" src="https://github.com/user-attachments/assets/2610f636-0159-4e5e-975e-50611eeefee7" />


## luci-app-modemband

### Информация о пакете Modemband

- Имя пакета: `luci-app-modemband`
- Версия: 2.0-r23
- Лицензия: MIT
- Источник: Rafał Wabik / IceG, поддержка modemband в LuCI JS
- Основная зависимость: `modemband`

### Возможности Modemband

- Страница обзора: производитель модема, модель, версия, IMEI, состояние устройства, основной AT-порт, оператор, технология доступа, текущая сота, сигнал, температура, напряжение, регион и информация SIM.
- Информация SIM: в первую очередь ICCID, IMSI, EID, оператор и тип SIM читаются из объекта SIM ModemManager; предусмотрен резервный путь через `AT+CPIN?`, `AT+QCCID` / `AT+CCID`, `AT+CIMI`.
- Настройка диапазонов: чтение и установка предпочитаемых диапазонов LTE, 5G SA, 5G NSA.
- Страница настроек: выбор порта связи, поведение при перезапуске WAN, поведение при перезапуске модема, переключатель уведомлений и файл шаблона.
- Определение модема: `loaded.sh` определяет текущий шаблон модема по UCI или USB Vendor/ProdID.

### Фронтенд-файлы Modemband

| Файл | Назначение |
| --- | --- |
| htdocs/luci-static/resources/view/modem/overview.js | Обзор модема в реальном времени, сигнал/сота/SIM |
| htdocs/luci-static/resources/view/modem/blte.js | Настройка диапазонов LTE/5G |
| htdocs/luci-static/resources/view/modem/blteconfig.js | Настройки приложения и редактирование шаблона |

### Бэкенд и права Modemband

- Отдельного серверного скрипта rpcd нет; в основном используются вызовы командной строки через LuCI `fs.exec_direct`.
- Исполняемые утилиты: `/usr/bin/modemband.sh`, `/usr/bin/loaded.sh`, `/usr/bin/mmcli`, `/usr/bin/sms_tool`
- Права на файлы: чтение `/dev`, `/etc/modemband`, `/usr/share/modemband`, запись `/etc/modemband` и `/usr/share/modemband/*`
- Права UCI: `modemband`, `luci-app-modemband`
- ACL: `root/usr/share/rpcd/acl.d/luci-app-modemband.json`

### Основные параметры UCI Modemband

| Параметр | Значение по умолчанию | Описание |
| --- | --- | --- |
| iface | wan | WAN-интерфейс, связанный с изменением диапазонов |
| wanrestart | 0 | Перезапускать ли WAN после изменения диапазонов |
| modemrestart | 0 | Перезапускать ли модем после изменения диапазонов |
| notify | 0 | Отключать или настраивать уведомления об изменениях |

### Источники данных Modemband

| Данные | Источник |
| --- | --- |
| Список и состояние модемов | `mmcli -L -J`, `mmcli -m <index> -J` |
| Местоположение/сота | `mmcli --location-get`, `AT+QENG="servingcell"` |
| Качество сигнала | ModemManager signal-quality, `AT+CSQ`, QENG RSRP/RSRQ/SINR |
| Технология доступа и диапазон | `AT+QNWINFO`, `AT+QENG="servingcell"` |
| Температура | `AT+QTEMP`, `AT+QTEMP?`, `AT+CPMUTEMP` |
| Напряжение | `AT+CBC` |
| Состояние SIM и номер | Объект SIM ModemManager, `AT+CPIN?`, `AT+QCCID` / `AT+CCID`, `AT+CIMI` |

### Скриншот Modemband

<img width="1628" height="1290" alt="image" src="https://github.com/user-attachments/assets/3a62a73f-6348-46a5-a46d-bceaa91525ba" />


## luci-app-sfp-status

### Информация о пакете SFP Status

- Имя пакета: `luci-app-sfp-status`
- Версия: 0.1.0-r31
- Архитектура: `all`
- Лицензия: Apache-2.0
- Сопровождающий: GitHub Copilot
- Сохраняемый файл конфигурации: `/etc/config/sfp-status`
- Форма страницы: include на странице «Статус > Обзор»; после обновления отдельный пункт меню SFP больше не сохраняется

### Возможности SFP Status

- Встраивание компонента состояния SFP в «Статус > Обзор» без отдельного пункта меню.
- Автоматическое обнаружение интерфейсов SFP/SFP+, с которых можно прочитать DOM.
- Поддержка запроса одного интерфейса и сводного запроса нескольких модулей.
- Несколько модулей отображаются на странице обзора в виде последовательных таблиц с заголовками Module, SFP1, SFP2 и т. д.
- Отображение модели модуля, температуры, скорости, напряжения, тока смещения, RX Power, TX Power и другой информации.
- Явные тайм-ауты при чтении UCI/RPC, чтобы страница обзора не зависала на pending promise.

### Совместимость с темами SFP Status

- Компонент использует стандартные структурные классы LuCI, такие как `cbi-section`, `table`, `tr`, `td` и `ifacebadge`.
- Работает в рамках штатной модели компоновки LuCI без специальных CSS-переопределений для страницы.
- Текущая реализация проверена с `luci-theme-argon` и поддерживает светлое бело-синее и тёмное сине-чёрное оформление.

### Ключевые файлы SFP Status

| Файл | Описание |
| --- | --- |
| htdocs/luci-static/resources/view/status/include/15_sfp.js | Include «Статус > Обзор», отрисовка таблицы одного или нескольких модулей |
| root/usr/libexec/rpcd/luci.sfp-status | Бэкенд rpcd с методами `getInterfaces`, `getStatus`, `getStatuses` |
| root/usr/share/rpcd/acl.d/luci-app-sfp-status.json | Определение прав ACL LuCI только для чтения |
| root/etc/config/sfp-status | Конфигурация UCI по умолчанию для отображения обзора SFP |
| .github/workflows/build-repository.yml | Единый workflow сборки всех пакетов и GitHub Pages-репозитория |

### Фронтенд-файлы SFP Status

| Файл | Назначение |
| --- | --- |
| htdocs/luci-static/resources/view/status/include/15_sfp.js | Include «Статус > Обзор» |

### Бэкенд и права SFP Status

- Бэкенд rpcd: `root/usr/libexec/rpcd/luci.sfp-status`
- Объект ubus: `luci.sfp-status`
- Методы только для чтения: `getInterfaces`, `getStatus`, `getStatuses`
- Источники данных: `/usr/sbin/ethtool`, `/sys/class/net`
- ACL: `root/usr/share/rpcd/acl.d/luci-app-sfp-status.json`

### Основные параметры UCI SFP Status

| Параметр | Значение по умолчанию | Описание |
| --- | --- | --- |
| overview_enabled | 1 | Показывать ли include SFP на странице обзора |

### Источники данных SFP Status

Если интерфейс не задан, бэкенд автоматически проверяет все сетевые устройства, с которых можно прочитать DOM SFP, и показывает их по очереди на странице обзора.

| Команда | Описание |
| --- | --- |
| `ethtool -m <ifname>` | Чтение телеметрии DOM и информации о модуле SFP |
| `ethtool <ifname>` | Чтение состояния канала, скорости, порта и дуплекса |
| `/sys/class/net/<ifname>/speed` | Резервный источник скорости, если `ethtool` её не сообщает |

### Автоматическая сборка SFP Status

- `luci-app-sfp-status` собирается единым workflow [build-repository.yml](.github/workflows/build-repository.yml) вместе со всеми остальными пакетами репозитория.
- Workflow собирает пакеты для 25.12 (apk), публикует общий GitHub Release и GitHub Pages-репозиторий.
- SFP-пакет попадает в общий релиз и в репозиторий вместе с остальными пакетами; отдельного релиза для SFP больше нет.
- В Makefile пакет объявлен как архитектура `all`, поэтому установочный пакет остаётся `all.apk` независимо от target SDK.

### Проверка работы SFP Status

После установки результата сборки проверяйте в таком порядке:

```sh
apk add --allow-untrusted luci-app-sfp-status_0.1.0-r31_all.apk
ubus -v list luci.sfp-status
ubus call luci.sfp-status getStatuses '{}'
```

Что проверить на странице:

1. После обновления в меню «Статус» не должно быть отдельного пункта страницы SFP.
2. Если браузер ранее открывал старую страницу, сначала выполните принудительное обновление, чтобы не использовать старый кэшированный JS.
3. Откройте «Статус > Обзор» и убедитесь, что обнаруженные SFP-модули отображаются внутри страницы обзора и корректно выглядят в теме Argon.

### Скриншот SFP Status

![Скриншот интерфейса SFP Status](https://github.com/user-attachments/assets/95d8c61b-aa50-432c-8650-cc5b61021d6d)

## Другие пакеты репозитория

В репозитории также есть пакеты, не входившие в основную сводку:

| Пакет | Назначение | Документация |
| --- | --- | --- |
| luci-app-traffic | Статистика трафика по приложениям и клиентам, диагностика NPU/TOPS | [README](Luci-app/luci-app-traffic/README.md) |
| luci-app-turboacc-mtk | Управление аппаратным ускорением MediaTek HNAT, PPE и TCP CCA | Makefile и страница `turboacc.js` |
| rpcd-mod-router-status | Телеметрия роутера только для чтения для мобильного приложения ImmortalWrt | [README](Luci-app/rpcd-mod-router-status/README.md) |

## Сборка и проверка

### Единая сборка на GitHub

Все пакеты собираются одним workflow [.github/workflows/build-repository.yml](.github/workflows/build-repository.yml):

- профиль `25.12-apk` — ImmortalWrt/OpenWrt 25.12, формат `apk`;
- собираются все приложения, `rpcd-mod-router-status` и все языковые пакеты;
- после сборки публикуется единый GitHub Release и обновляется GitHub Pages-репозиторий.

### Сборка через OpenWrt SDK

Поместите соответствующее приложение в LuCI feed или в `feeds/luci/applications/`, затем собирайте отдельно по имени пакета:

```sh
make package/feeds/luci/luci-app-fan/compile V=s
make package/feeds/luci/luci-app-modemband/compile V=s
make package/feeds/luci/luci-app-sfp-status/compile V=s
make package/feeds/luci/luci-app-traffic/compile V=s
make package/feeds/luci/luci-app-turboacc-mtk/compile V=s
make package/feeds/luci/rpcd-mod-router-status/compile V=s
```

### Русские переводы

- Для `luci-app-fan`, `luci-app-modemband`, `luci-app-sfp-status`, `luci-app-traffic` и `luci-app-turboacc-mtk` русские каталоги лежат в `po/ru/` и собираются в отдельные пакеты `luci-i18n-<app>-ru`.
- Основной пакет приложения не содержит `.lmo`; перевод устанавливается отдельным пакетом.
- После установки выберите русский язык в LuCI: **Система → Язык и стиль**. Если нужного языка нет в списке, установите соответствующий пакет `luci-i18n-*-ru`.

### Проверка переводов

Скрипт проверяет, что все msgid из JS-страниц, меню и ACL присутствуют во всех каталогах `po/*/*.po`:

```sh
node tools/check-translations.js
```

### Общая проверка после установки

```sh
rm -rf /tmp/luci-modulecache /var/luci-modulecache
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* /var/luci-indexcache.*
/etc/init.d/rpcd reload
```

### Проверка интерфейсов во время работы

```sh
ubus -v list luci.fan
ubus call luci.fan getStatus '{}'

ubus -v list luci.sfp-status
ubus call luci.sfp-status getStatuses '{}'
```

У modemband нет отдельного объекта ubus; во время работы проверяйте команды и права страницы:

```sh
mmcli -L -J
mmcli -m 0 -J
sms_tool -d /dev/ttyUSB2 at AT+CSQ
sms_tool -d /dev/ttyUSB2 at AT+CPIN?
```

### Проверка страниц LuCI

| Приложение | Страница |
| --- | --- |
| luci-app-fan | Статус > Управление вентилятором |
| luci-app-modemband | Модем > Настройка модема > Обзор / Настройки диапазонов / Настройка |
| luci-app-sfp-status | Блок SFP на странице «Статус > Обзор» |
| luci-app-traffic | Статус > Анализ трафика |
| luci-app-turboacc-mtk | Сеть > TurboACC |

## Замечания по сопровождению

- При добавлении новой JS-страницы LuCI одновременно проверяйте `menu.d`, `acl.d`, `po/ru`, `po/zh_Hans` и состав установки в Makefile; полноту переводов проверяйте через `node tools/check-translations.js`.
- При добавлении метода ubus одновременно ужесточайте ACL, открывая только фактически используемые методы.
- Вызовы UCI, RPC или аппаратного опроса внутри include страницы статуса должны иметь явные тайм-ауты, чтобы не блокировать всю страницу статуса.
- После изменения фронтенд-ресурсов запускайте как минимум `node --check` и очищайте кэш модулей/индексов LuCI.
- При адаптации темы сначала используйте штатные структуры LuCI `cbi-section`, `table`, `tr`, `td`, `ifacebadge`; при необходимости собственных стилей сохраняйте светлую бело-синюю и тёмную сине-чёрную основу Argon.
