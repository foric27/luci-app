# netpulse — сервер NetPulse в режиме on-box для OpenWrt.
#
# Сервер (server-go) и встроенные бинарники агента (agent) собираются из
# исходников репозитория gnacho/netpulse Go-тулчейном фида (golang/host).
# Фронтенд upstream собирает через npm, а host-node в buildroot/SDK нет,
# поэтому SPA берётся из официального артефакта релиза app-dist-<версия>.tar.gz
# (build.sh скачивает его и проверяет sha256).
#
# Логика сборки вынесена в build.sh (см. рядом): в рецепте Build/Compile
# OpenWrt неудобно экранировать shell-переменные, а скрипт проще проверить.

include $(TOPDIR)/rules.mk

PKG_NAME:=netpulse
PKG_VERSION:=2.52.0
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/gnacho/netpulse.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)
PKG_MIRROR_HASH:=skip

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Nacho <netpulse@cloudless.club>

PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Package/netpulse
	SECTION:=net
	CATEGORY:=Network
	TITLE:=NetPulse network monitor (on-box server)
	URL:=https://github.com/gnacho/netpulse
	DEPENDS:=+curl +ca-bundle @(aarch64||arm||x86_64)
endef

define Package/netpulse/description
	NetPulse server running on-box: serves the web app and ingests agent
	data over HTTPS with self-signed TLS + SPKI pinning. Stores data in
	SQLite (overlay or USB). Same binary as the dedicated-node deployment.
endef

# Go-тулчейн фида: символическая ссылка golang<версия>/host -> lib/go-<версия>/bin/go.
NETPULSE_GO:=$(STAGING_DIR_HOSTPKG)/lib/go-$(GO_HOST_VERSION)/bin/go

define Build/Compile
	GO_BIN="$(NETPULSE_GO)" sh "$(CURDIR)/build.sh" \
		"$(PKG_BUILD_DIR)" "$(PKG_VERSION)" "$(GO_ARCH)"
endef

define Package/netpulse/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/netpulse $(1)/usr/sbin/netpulse

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/netpulse-server.init $(1)/etc/init.d/netpulse

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/netpulse-server.config $(1)/etc/config/netpulse

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/netpulse-server.defaults $(1)/etc/uci-defaults/95-netpulse-server
endef

$(eval $(call BuildPackage,netpulse))
