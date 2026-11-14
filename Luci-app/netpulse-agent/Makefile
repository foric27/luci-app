# netpulse-agent — агент NetPulse для OpenWrt (пакет репозитория luci-app).
#
# Собирает статический Go-бинарник из каталога agent/ репозитория
# gnacho/netpulse. Скрипты procd/UCI/uci-defaults лежат в files/ этого
# пакета (взяты из upstream deploy/openwrt/netpulse-agent/files).
#
# Без UPX (хост-утилита не нужна); Go-тулчейн берётся из фида (golang/host).

include $(TOPDIR)/rules.mk

PKG_NAME:=netpulse-agent
# Версия пакета = тег релиза NetPulse; версия самого агента берётся из
# agent/VERSION (она у проекта отвязана от тега, см. .goreleaser.yaml).
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

define Package/netpulse-agent
	SECTION:=utils
	CATEGORY:=Utilities
	TITLE:=NetPulse native agent for OpenWrt
	URL:=https://github.com/gnacho/netpulse
	DEPENDS:=+iw @(aarch64||arm||x86_64)
endef

define Package/netpulse-agent/description
	Native OpenWrt agent for the NetPulse network monitor: probes the local
	router (system, wireless, DHCP, bridge FDB) and pushes data to a NetPulse
	server. Stateless, logs to syslog; configured in /etc/config/netpulse-agent.
endef

# agent/ — отдельный Go-модуль внутри монорепозитория netpulse.
# CGO_ENABLED=0 даёт статический бинарник, пригодный для musl-таргета.
define Build/Compile
	cd $(PKG_BUILD_DIR)/agent && \
		$(GO_BIN_PATH) \
		CGO_ENABLED=0 \
		GOOS=linux \
		GOARCH=$(GO_ARCH) \
		GOTOOLCHAIN=local \
		GOFLAGS=-mod=mod \
		GOCACHE=$(BUILD_DIR)/.netpulse-go/.gocache \
		GOPATH=$(BUILD_DIR)/.netpulse-go/.gopath \
		GOMODCACHE=$(BUILD_DIR)/.netpulse-go/.gopath/pkg/mod \
		go build -trimpath -buildvcs=false \
			-ldflags "-s -w -X main.Version=$(shell cat $(PKG_BUILD_DIR)/agent/VERSION 2>/dev/null)" \
			-o $(PKG_BUILD_DIR)/netpulse-agent ./cmd/netpulse-agent
endef

define Package/netpulse-agent/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/netpulse-agent $(1)/usr/sbin/netpulse-agent

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/netpulse-agent.init $(1)/etc/init.d/netpulse-agent

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/netpulse-agent.config $(1)/etc/config/netpulse-agent

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/netpulse-agent.defaults $(1)/etc/uci-defaults/90-netpulse-agent
endef

$(eval $(call BuildPackage,netpulse-agent))
