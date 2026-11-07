#
# Copyright 2022-2024 Rafał Wabik - IceG - From eko.one.pl forum
#
# MIT License
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Поддержка modemband в LuCI JS
LUCI_DESCRIPTION:=Интерфейс LuCI JS для modemband. Пакет позволяет настраивать диапазоны LTE/5G для поддерживаемых модемов 4G/5G.
LUCI_DEPENDS:=+modemband

PKG_NAME:=luci-app-modemband
PKG_VERSION:=2.0
PKG_RELEASE:=24

define Package/luci-app-modemband/postinst
#!/bin/sh
if [ -z "$$IPKG_INSTROOT" ]; then
	rm -rf /tmp/luci-modulecache/ /var/luci-modulecache/
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* /var/luci-indexcache.* 2>/dev/null
	[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
