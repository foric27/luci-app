# Copyright (C) 2026 finerain6
#
# This is free software, licensed under the Apache License, Version 2.0.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-avahi-publisher
PKG_VERSION:=1.0.1
PKG_RELEASE:=2
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE

# Original author and maintainer of the upstream package.
PKG_MAINTAINER:=finerain6 <finerain6@users.noreply.github.com>

LUCI_TITLE:=Публикация сервисов Avahi в LuCI
LUCI_DESCRIPTION:=Публикует записи Bonjour/DNS-SD для сервисов, размещённых на других устройствах локальной сети.
LUCI_DEPENDS:=+luci-base +avahi-dbus-daemon +jshn
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/finerain6/luci-app-avahi-publisher
LUCI_MAINTAINER:=finerain6 <finerain6@users.noreply.github.com>

define Package/$(PKG_NAME)/conffiles
/etc/config/avahi-publisher
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
