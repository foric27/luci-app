#!/bin/sh
# build.sh — сборка сервера NetPulse и встроенных бинарников агента
# для пакета netpulse (on-box сервер OpenWrt).
#
# Использование:
#   GO_BIN=/path/to/go sh build.sh BUILD_DIR VERSION GOARCH [SPA_TARBALL]
#
#   BUILD_DIR   — распакованный исходник netpulse (PKG_BUILD_DIR)
#   VERSION     — версия сервера (тег релиза без ведущего "v")
#   GOARCH      — целевая архитектура Go (arm64/arm/amd64)
#   SPA_TARBALL — необязательный tar.gz с собранным фронтендом; если не задан,
#                 скачивается официальный артефакт релиза и проверяется sha256
set -eu

BUILD_DIR="$1"
VERSION="$2"
GO_ARCH="$3"
SPA_TARBALL="${4:-}"
GO_BIN="${GO_BIN:?GO_BIN is not set}"
SPA_URL="https://github.com/gnacho/netpulse/releases/download/v$VERSION/app-dist-v$VERSION.tar.gz"
# sha256 официального app-dist-v<версия>.tar.gz из релиза NetPulse.
SPA_SHA256="1e13bf149859efa0990b3b0e6f9825ecdfd8f72ab20b1ba1b5a82227cdf8bdc6"

[ -d "$BUILD_DIR/server-go" ] || {
	echo "build.sh: $BUILD_DIR/server-go not found" >&2
	exit 1
}
[ -f "$BUILD_DIR/agent/VERSION" ] || {
	echo "build.sh: $BUILD_DIR/agent/VERSION not found" >&2
	exit 1
}

# Приводим пути к абсолютным: Go требует абсолютный GOPATH.
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"

# Официальный SPA-артефакт: используем переданный файл или скачиваем.
if [ -z "$SPA_TARBALL" ] || [ ! -f "$SPA_TARBALL" ]; then
	SPA_TARBALL="$BUILD_DIR/app-dist-$VERSION.tar.gz"
	if [ ! -f "$SPA_TARBALL" ]; then
		if command -v curl >/dev/null 2>&1; then
			curl -fsSL --retry 3 -o "$SPA_TARBALL.part" "$SPA_URL"
		elif command -v wget >/dev/null 2>&1; then
			wget -q -O "$SPA_TARBALL.part" "$SPA_URL"
		else
			echo "build.sh: curl or wget is required to download $SPA_URL" >&2
			exit 1
		fi || {
			rm -f "$SPA_TARBALL.part"
			echo "build.sh: cannot download $SPA_URL" >&2
			exit 1
		}
		_got_sha="$(sha256sum "$SPA_TARBALL.part" | awk '{print $1}')"
		if [ "$_got_sha" != "$SPA_SHA256" ]; then
			rm -f "$SPA_TARBALL.part"
			echo "build.sh: app-dist sha256 mismatch: $_got_sha" >&2
			exit 1
		fi
		mv "$SPA_TARBALL.part" "$SPA_TARBALL"
	fi
fi
SPA_TARBALL="$(cd "$(dirname "$SPA_TARBALL")" && pwd)/$(basename "$SPA_TARBALL")"

export CGO_ENABLED=0
export GOOS=linux
export GOTOOLCHAIN=local
export GOFLAGS=-mod=mod
export GOCACHE="$BUILD_DIR/.gocache"
export GOPATH="$BUILD_DIR/.gopath"
export GOMODCACHE="$BUILD_DIR/.gopath/pkg/mod"
# proxy.golang.org иногда отвечает 403 на большие модули (redirect на
# storage.googleapis.com); разделитель "|" разрешает откат на прямой fetch.
export GOPROXY="${GOPROXY:-https://proxy.golang.org|direct}"

case "$GO_ARCH" in
	arm) export GOARM=7 ;;
esac

AGENT_VERSION="$(cat "$BUILD_DIR/agent/VERSION")"
AGENTS_DIR="$BUILD_DIR/server-go/internal/agentbin/agents"
SPA_DIR="$BUILD_DIR/server-go/internal/staticspa/dist"

# 1. SPA: официальный артефакт релиза вместо npm-сборки (host-node нет).
rm -rf "$SPA_DIR"
mkdir -p "$SPA_DIR"
tar -xzf "$SPA_TARBALL" -C "$SPA_DIR"

# 2. Бинарники агента для установки агентов из веб-интерфейса
#    (amd64/arm64/arm — как в goreleaser; имя файла задаёт agentbin.Open()).
for arch in amd64 arm64 arm; do
	(
		cd "$BUILD_DIR/agent" || exit 1
		GOARCH="$arch" "$GO_BIN" build -trimpath -buildvcs=false \
			-ldflags "-s -w -X main.Version=$AGENT_VERSION" \
			-o "$AGENTS_DIR/netpulse-agent-$arch" ./cmd/netpulse-agent
	) || exit 1
done

# 3. Сам сервер (фронтенд и агенты уже встроены в дерево исходников).
cd "$BUILD_DIR/server-go" || exit 1
GOARCH="$GO_ARCH" "$GO_BIN" build -trimpath -buildvcs=false \
	-ldflags "-s -w \
		-X github.com/gnacho/netpulse/server-go/internal/agentbin.EmbeddedAgentVersion=$AGENT_VERSION \
		-X github.com/gnacho/netpulse/server-go/internal/httpapi.Version=$VERSION" \
	-o "$BUILD_DIR/netpulse" ./cmd/netpulse
