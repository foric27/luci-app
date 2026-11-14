# Copyright (C) 2026 Nacho (upstream gnacho/netpulse, AGPL-3.0-only)
#
# Адаптировано для репозитория пакетов foric27/luci-app: LuCI-страница
# локального агента NetPulse. Код страниц и rpcd-плагина — из upstream,
# переводы ru/zh_Hans и упаковка — в этом репозитории.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-netpulse
PKG_VERSION:=2.7.2
PKG_RELEASE:=1
PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILES:=LICENSE

# Автор upstream-приложения.
PKG_MAINTAINER:=Nacho <netpulse@cloudless.club>

LUCI_TITLE:=NetPulse: локальное состояние агента
LUCI_DESCRIPTION:=Страница LuCI для агента NetPulse на этом роутере: состояние procd, версия, журнал, перезапуск, настройки UCI и проверка связи с сервером.
LUCI_DEPENDS:=+luci-base +netpulse-agent
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/gnacho/netpulse

define Build/Prepare/$(PKG_NAME)
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.netpulse
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -z "$$IPKG_INSTROOT" ]; then
	[ -f /usr/libexec/rpcd/luci.netpulse ] && chmod 0755 /usr/libexec/rpcd/luci.netpulse
	rm -rf /tmp/luci-modulecache/ /var/luci-modulecache/
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* /var/luci-indexcache.* 2>/dev/null
	[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
