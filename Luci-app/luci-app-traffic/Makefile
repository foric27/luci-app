include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-traffic
PKG_VERSION:=2.0.0
PKG_RELEASE:=5
PKG_LICENSE:=Apache-2.0
LUCI_PKGARCH:=all

LUCI_TITLE:=Статистика трафика по приложениям в LuCI
LUCI_DESCRIPTION:=Статистика трафика по приложениям в стиле UCG: итоги берутся из счётчиков интерфейса WAN и остаются точными при включённой разгрузке потоков; разбивка по приложениям строится по conntrack, сопоставленному с DNS-ответами AdGuard Home, а прокси-туннель учитывается отдельно.
LUCI_DEPENDS:=+luci-base +lua +luci-lib-nixio +curl +ca-bundle +coreutils-timeout

define Build/Prepare/$(PKG_NAME)
	$(call Build/Prepare/Default)
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/uci-defaults/40_luci-traffic
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/traffic
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.traffic
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/traffic/collector.sh
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/traffic/fetch-icons.sh
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/traffic/website-icons.sh
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/traffic/live.sh
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/traffic/realtime.sh
	$(SED) 's|^COLLECTOR_VERSION=.*|COLLECTOR_VERSION=$(PKG_VERSION)-r$(PKG_RELEASE)|' \
		$(PKG_BUILD_DIR)/root/usr/share/traffic/collector.sh
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/traffic
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
if [ -x /etc/init.d/traffic ]; then
	/etc/init.d/traffic stop >/dev/null 2>&1
	if [ "$${1:-}" != "upgrade" ] && [ "$${PKG_UPGRADE:-0}" != "1" ]; then
		/etc/init.d/traffic disable >/dev/null 2>&1
	fi
fi
pkill -f '/usr/share/traffic/collector.sh' >/dev/null 2>&1
nft delete table inet traffic_acct >/dev/null 2>&1
# opkg calls the installed prerm with "upgrade <new-version>". Preserve
# counters AND archive snapshots so the next collector neither loses nor
# double-archives the current hour. APK pre-deinstall has no argument.
if [ "$${1:-}" != "upgrade" ] && [ "$${PKG_UPGRADE:-0}" != "1" ]; then
	rm -rf /tmp/traffic
fi
exit 0
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -z "$$IPKG_INSTROOT" ]; then
	[ -f /etc/uci-defaults/40_luci-traffic ] && chmod 0755 /etc/uci-defaults/40_luci-traffic
	[ -f /etc/init.d/traffic ] && chmod 0755 /etc/init.d/traffic
	[ -f /usr/libexec/rpcd/luci.traffic ] && chmod 0755 /usr/libexec/rpcd/luci.traffic
	[ -f /usr/share/traffic/collector.sh ] && chmod 0755 /usr/share/traffic/collector.sh
	rm -rf /tmp/luci-modulecache/ /var/luci-modulecache/
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* /var/luci-indexcache.* 2>/dev/null
	[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload >/dev/null 2>&1 || true
	[ -x /etc/uci-defaults/40_luci-traffic ] && /etc/uci-defaults/40_luci-traffic >/dev/null 2>&1
	if [ -x /etc/init.d/traffic ]; then
		/etc/init.d/traffic enable >/dev/null 2>&1
		/etc/init.d/traffic restart >/dev/null 2>&1
	fi
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# include/scan.mk finds packages by grepping their Makefile for "call
# BuildPackage", so this marker is what makes the package discoverable at all -
# without it the SDK skips the directory silently and the package is not built.
# call BuildPackage - OpenWrt buildroot signature
