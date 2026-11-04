#!/bin/bash
# collector-selftest.sh - offline regression for luci-app-traffic's collector.
#
# Runs collector.sh against a synthetic conntrack snapshot, a stub lua standing
# in for ans.lua (the real one needs a lua interpreter and the router's querylog,
# so it is exercised on the device) and small apps/categories tables, then
# asserts every attribution path:
#
#   1. exact host name wins over a suffix       (music.163.com not 163.com)
#   2. plain suffix hit                          (www.taobao.com -> Taobao)
#   3. longest suffix wins                       (deep.cdn.example.com -> Deep,
#                                                 not the shorter example.com)
#   4. multi-label suffix needs no public suffix list
#                                                (a.bar.co.uk -> Foo Bar UK)
#   5. category suffix hit                       (x.fastly.net -> CDN)
#   6. nothing in either table -> the site itself (shop.unknownsite.org)
#   7. DNS answered for another client -> "any" (9.9.9.9 -> Example Org)
#   8. no DNS answer, protocol bucket            (443/tcp -> SSL/TLS, 443/udp ->
#                                                 QUIC, 554/tcp -> RTSP)
#   9. the same address:port over tcp and udp counted separately
#  10. router-originated traffic kept out of the application list
#  11. the catalogue is read only for new host names, and a changed catalogue
#      invalidates the cached name map
#  12. the box's own LAN addresses are not clients, whether v4 or v6, while a
#      real client on the same prefixes still is
#  13. an older state schema rebuilds the running totals instead of keeping a
#      row that must no longer exist, and a matching one does not
#  14. the box addresses are found without being configured, which is the path
#      the router actually takes
#
#   bash collector-selftest.sh
set -u

SELF="$(cd "$(dirname "$0")" && pwd)"

# Windows ships same-named tools that do not accept the same arguments -
# sort.exe and timeout.exe among them - and on this machine
# /c/WINDOWS/system32 precedes everything else in PATH, so collector.sh's
# `acct_hosts | sort -u` failed with "-uThe system cannot find the file
# specified." and the host list came back empty: no per-client nft rules, no
# counters, an empty clients.tsv.  MSYS does provide coreutils sort, so the
# MSYS directories go first and the POSIX behaviour this suite assumes is
# restored.  `timeout` cannot be fixed this way - MSYS ships none - which is
# why the nft phase supplies its own shim.
PATH="/usr/bin:/bin:$PATH"
export PATH
# COLLECTOR_SRC points every phase at another revision of the collector: an
# assertion that cannot be made to fail on the code it was written against
# proves nothing, and the only honest way to check that is to run it there.
COLLECTOR="${COLLECTOR_SRC:-$(cd "$SELF/.." && pwd)/root/usr/share/traffic/collector.sh}"
# The collector's live-counter schema, read from the collector rather than written
# out here.  A phase that seeds a counter file has to also seed a matching version,
# or init_state() treats the state as older and drops exactly what was seeded -
# which is how the WAN baseline phase first failed.  Deriving it means the next
# bump cannot silently break these phases.
SCHEMA=$(sed -n 's/^STATE_VERSION=//p' "$COLLECTOR")
[ -f "$COLLECTOR" ] || { echo "collector.sh not found next to $SELF" >&2; exit 1; }

echo "=== sh -n ==="
# An apostrophe inside an awk comment closes the single-quoted program the shell
# is already inside - the awk program ends early, the rest of it is parsed as
# shell, and sh -n reports a syntax error far from the real cause.  It has been
# written three times in this file's history, so it gets its own check that
# names the offending line.
#
# The check tracks whether an odd number of quotes has been opened, rather than
# entering an "inawk" state and leaving it again.  The state version carried an
# exit rule that required the closing quote to be followed by a space after at
# most four spaces of indent, so every TAB-indented closer and every eight-space
# closer in this file missed it.  inawk was therefore set by the first awk
# invocation and never cleared, and from there on it reported every ordinary
# shell comment that happened to contain an apostrophe - the day's, session's,
# hour's, page's.  That made the file fail its lint, and this suite exits on
# that failure, so it never reached a single functional assertion.  Which is how
# a joined-up line in record_sample shipped and crash-looped the collector
# without any test noticing.
#
# A line that starts with # while no quoted region is open is a shell comment:
# the shell does not look inside it for quotes at all, so it can neither open
# nor close an awk program and an apostrophe in it is harmless.
apostrophes=$(awk '
    BEGIN { q = 0 }
    {
        if (q % 2 == 0 && $0 ~ /^[[:space:]]*#/) next
        line = $0
        n = gsub(/\x27/, "\x27", line)
        if (q % 2 == 1 && $0 ~ /^[[:space:]]*#/ && n > 0) {
            printf "  line %d: %s\n", NR, $0
            hits++
        }
        q += n
    }
    END { exit (hits > 0 ? 1 : 0) }
' "$COLLECTOR")
if [ -n "$apostrophes" ]; then
    echo "FAIL: apostrophe inside an awk comment closes the program early:" >&2
    echo "$apostrophes" >&2
    exit 1
fi
echo "no apostrophes inside awk programs"
if ! sh -n "$COLLECTOR"; then
    # A syntax error makes every later assertion meaningless, so stop here
    # rather than printing a wall of failures.  This is the check that catches
    # an apostrophe inside an awk comment, which closes the single-quoted awk
    # program the shell is already inside.
    echo "FAIL: collector.sh does not parse - aborting" >&2
    exit 1
fi
echo "collector syntax OK"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

# stub lua: swallow the querylog lines and emit fixed (client, domain, ip) rows.
# The last row resolves for a different client, which is what makes a flow fall
# back to the "any client answered this address" path.
cat > "$T/bin/lua" <<'EOF'
#!/bin/sh
n=0
while read -r _; do n=$((n+1)); done
[ "$n" -gt 0 ] || exit 0
printf '192.168.2.138\tmusic.163.com\t1.1.1.1\n'
printf '192.168.2.138\twww.taobao.com\t2.2.2.2\n'
printf '192.168.2.138\tx.fastly.net\t3.3.3.3\n'
printf '192.168.2.138\tdeep.cdn.example.com\t4.4.4.4\n'
printf '192.168.2.138\ta.bar.co.uk\t7.7.7.7\n'
printf '192.168.2.138\tshop.unknownsite.org\t8.8.8.8\n'
printf '192.168.2.138\tWWW.MEITUAN.COM\t10.10.10.10\n'
printf '192.168.2.139\texample.org\t9.9.9.9\n'
exit 0
EOF
chmod +x "$T/bin/lua"

# <name> <TAB> <key> <TAB> H|S   (H = exact host name, S = suffix match)
{
    printf 'NetEase Music\tmusic.163.com\tH\n'
    printf 'NetEase\t163.com\tS\n'
    printf 'Taobao\ttaobao.com\tS\n'
    printf 'Deep\tcdn.example.com\tS\n'
    printf 'Example\texample.com\tS\n'
    printf 'Foo Bar UK\tbar.co.uk\tS\n'
    printf 'Example Org\texample.org\tS\n'
    printf 'Meituan\tmeituan.com\tS\n'
} > "$T/apps.tsv"
printf '# category<TAB>suffix\nCDN\tfastly.net\nAds\tdoubleclick.net\n' > "$T/categories.tsv"
printf '{"IP":"192.168.2.138","QH":"x","Answer":"y"}\n'  > "$T/ql"

# One flow per line.  $6 is the client->server counter (upload) and $7 the
# server->client counter (download), matching the order the collector reads.
cat > "$T/ct" <<'EOF'
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=1.1.1.1 sport=1001 dport=443 packets=1 bytes=100 tos=0 src=1.1.1.1 dst=192.168.2.138 sport=443 dport=1001 packets=1 bytes=1000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=2.2.2.2 sport=1002 dport=443 packets=1 bytes=200 tos=0 src=2.2.2.2 dst=192.168.2.138 sport=443 dport=1002 packets=1 bytes=2000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=3.3.3.3 sport=1003 dport=443 packets=1 bytes=300 tos=0 src=3.3.3.3 dst=192.168.2.138 sport=443 dport=1003 packets=1 bytes=3000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=4.4.4.4 sport=1004 dport=443 packets=1 bytes=400 tos=0 src=4.4.4.4 dst=192.168.2.138 sport=443 dport=1004 packets=1 bytes=4000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=5.5.5.5 sport=1005 dport=443 packets=1 bytes=500 tos=0 src=5.5.5.5 dst=192.168.2.138 sport=443 dport=1005 packets=1 bytes=5000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 udp 17 119 ESTABLISHED src=192.168.2.138 dst=5.5.5.5 sport=1006 dport=443 packets=1 bytes=600 tos=0 src=5.5.5.5 dst=192.168.2.138 sport=443 dport=1006 packets=1 bytes=6000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=6.6.6.6 sport=1007 dport=554 packets=1 bytes=700 tos=0 src=6.6.6.6 dst=192.168.2.138 sport=554 dport=1007 packets=1 bytes=7000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=7.7.7.7 sport=1008 dport=443 packets=1 bytes=800 tos=0 src=7.7.7.7 dst=192.168.2.138 sport=443 dport=1008 packets=1 bytes=8000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=8.8.8.8 sport=1009 dport=443 packets=1 bytes=900 tos=0 src=8.8.8.8 dst=192.168.2.138 sport=443 dport=1009 packets=1 bytes=9000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=9.9.9.9 sport=1010 dport=443 packets=1 bytes=1000 tos=0 src=9.9.9.9 dst=192.168.2.138 sport=443 dport=1010 packets=1 bytes=10000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.138 dst=10.10.10.10 sport=1011 dport=443 packets=1 bytes=1100 tos=0 src=10.10.10.10 dst=192.168.2.138 sport=443 dport=1011 packets=1 bytes=11000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.1.6 dst=45.149.157.234 sport=1012 dport=443 packets=1 bytes=800 tos=0 src=45.149.157.234 dst=192.168.1.6 sport=443 dport=1012 packets=1 bytes=8000 tos=0 [ASSURED] mark=0 zone=0 use=2
EOF

# Run the collector until it has finished one whole round, then stop it.
#
# A fixed timeout cannot express this.  A round costs a handful of forks per
# stage, so on a slow or loaded host a single round can outlast any budget worth
# writing - and when it does, the collector is killed halfway through and the
# assertion fails for a reason that has nothing to do with the code.  That is
# exactly what made phases 15, 17, 18 and 19 fail intermittently here.
#
# collected_at is written by the last stage of a round, so a change in it means
# the round is complete.  The timeout stays as a safety net for a collector that
# wedges before writing anything.
run_collector() {
    local cap="${1:-30}"; shift
    collect "$T/state" "$T/data" "$T/ct" "$T/ql" "$cap" "$@"
}

# The same, against a state directory of its own, so a phase that needs a clean
# slate does not have to disturb the one the earlier assertions built up.
run_collector_at() {
    local cap="${1:-30}" st="$2" da="$3" ct="$4" ql="$5"; shift 5
    collect "$st" "$da" "$ct" "$ql" "$cap" "$@"
}

snapshot_at() { sed -n 's/.*"collected_at":\([0-9]*\).*/\1/p' "$1" 2>/dev/null; }
# Completed rounds, not collected_at: the collector now writes a snapshot as soon
# as it starts, so collected_at changes before any work is done.  Waiting on the
# round counter is what "one whole round has finished" actually means.
rounds_at() { sed -n 's/.*"rounds":\([0-9]*\).*/\1/p' "$1" 2>/dev/null; }

collect() {
    local st="$1" da="$2" ct="$3" ql="$4" cap="$5"; shift 5
    local before pid i at
    # Empty means "no snapshot yet", which is round 0, not "a round finished":
    # the collector publishes a snapshot at startup with rounds=0, so waiting for
    # the value to merely differ would return before the first round has run.
    before=$(rounds_at "$st/summary.json")
    case "$before" in ''|*[!0-9]*) before=0 ;; esac

    # Started directly rather than under timeout.  Wrapping it meant killing a
    # wrapper and hoping the signal reached the collector; when it did not, the
    # survivor kept collecting in the same state directory, advanced the round
    # counter by itself, and the next phase saw "a round finished" that its own
    # collector had not run - so that run was killed before doing any work.  That
    # is what made phases 15 to 19 fail intermittently for so long.  The bound on
    # the wait below is what timeout used to provide.
    # Generic attribution cases have no WAN. Interface cases override these
    # fixtures explicitly; never accidentally measure the CI host interface.
    env TRAFFIC_PROC_NET_DEV=/nonexistent TRAFFIC_PROC_NET_ROUTE=/nonexistent TRAFFIC_PROC_NET_ROUTE6=/nonexistent "$@" UCI=/bin/true LUA="$T/bin/lua" CT="$ct" TRAFFIC_QUERYLOG="$ql" \
      TRAFFIC_LAN4=192.168.2. TRAFFIC_INTERVAL=2 TRAFFIC_DATADIR="$da" \
      TRAFFIC_APPMAP="$T/apps.tsv" TRAFFIC_CATEGORIES="$T/categories.tsv" \
      STATE_DIR="$st" SELF_DIR="$(cd "$SELF/../root/usr/share/traffic" && pwd)" \
      sh "$COLLECTOR" >/dev/null 2>&1 &
    pid=$!

    i=0
    while [ "$i" -lt $((cap * 5)) ]; do
        at=$(rounds_at "$st/summary.json")
        case "$at" in ''|*[!0-9]*) at=0 ;; esac
        [ "$at" -gt "$before" ] && break
        sleep 0.2
        i=$((i + 1))
    done

    # Stop it for real before the next phase touches the same state: signal it,
    # wait for it to go, and then pause briefly, because a command it had already
    # started (the resolver appends to the name map) outlives the shell and would
    # otherwise still be writing while the next phase reads.
    kill "$pid" 2>/dev/null
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 60 ]; do
        sleep 0.1
        i=$((i + 1))
    done
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    sleep 0.3
    return 0
}

run_collector 30

echo
echo "--- totals ---"
cat "$T/state/totals.tsv"
echo "--- router ---"; cat "$T/state/router.tsv"
echo "--- stat  ---"; cat "$T/state/stat.tsv"
echo "--- namemap (host, kind, name) ---"; cat "$T/state/namemap.tsv"

echo
echo "=== Проверки ==="
fail=0
row() { awk -F'\t' -v n="$1" '$1==n {print $2"/"$3}' "$T/state/totals.tsv"; }
nm()  { awk -F'\t' -v h="$1" '$1==h {print $2" "$3}' "$T/state/namemap.tsv"; }
chk() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expect '$2', got '$3')"; fail=1; fi; }

chk "1  точное имя хоста важнее суффикса"            "100/1000"   "$(row 'NetEase Music')"
chk "1a другие домены того же суффикса относятся к себе"       ""           "$(row 'NetEase')"
chk "2  обычный суффикс совпал"                    "200/2000"   "$(row 'Taobao')"
chk "3  самый длинный суффикс важнее (cdn.example.com)"  "400/4000"   "$(row 'Deep')"
chk "3a короткий суффикс не забрал трафик длинного"         ""           "$(row 'Example')"
chk "4  многоуровневый суффикс (bar.co.uk)"          "800/8000"   "$(row 'Foo Bar UK')"
chk "5  суффикс категории совпал -> CDN"             "300/3000"   "$(row 'CDN')"
chk "6  нет записи -> собственный домен сайта"           "900/9000"   "$(row 'unknownsite.org')"
chk "7  адрес разрешён другим клиентом -> совпадение"    "1000/10000" "$(row 'Example Org')"
chk "7b имя хоста в верхнем регистре после нормализации совпадает"          "1100/11000" "$(row 'Meituan')"
chk "8a нет DNS + tcp/443 -> SSL/TLS"     "500/5000"   "$(row 'SSL/TLS')"
chk "8b нет DNS + udp/443 -> QUIC"        "600/6000"   "$(row 'QUIC')"
chk "8c нет DNS + tcp/554 -> RTSP"        "700/7000"   "$(row 'RTSP')"
chk "10 трафик туннеля учитывается отдельно"                   "8800"       "$(cat "$T/state/router.tsv")"
chk "11 сумма трёх категорий = итог клиентов"         "72600"      "$(awk -F'\t' '{s+=$1+$2+$3+$4} END{print s+0}' "$T/state/stat.tsv")"
chk "11a именовано (DNS того же клиента)"              "38500"      "$(cut -f1 "$T/state/stat.tsv")"
chk "11b именовано (DNS любого клиента)"            "11000"      "$(cut -f2 "$T/state/stat.tsv")"
chk "11c отнесено к категории"                        "3300"       "$(cut -f3 "$T/state/stat.tsv")"
chk "11d прочее (протокольная корзина)"                  "19800"      "$(cut -f4 "$T/state/stat.tsv")"
chk "12 туннель не попал в список приложений"               "11"         "$(grep -c . "$T/state/totals.tsv")"
# read a field out of the snapshot's totals object only - a bare grep for
# "down": would also match every per-application entry
tot() { grep -o '"totals":{[^}]*}' "$T/state/summary.json" | grep -o "\"$1\":[0-9]*" | cut -d: -f2; }
chk "13 снимок totals.down"                 "66000"      "$(tot down)"
chk "13a снимок totals.up"                  "6600"       "$(tot up)"
chk "13b снимок totals.router"              "8800"       "$(tot router)"

echo
echo "=== Кэш имён (resolve-on-insert) ==="
chk "14 namemap записывает точное совпадение"             "app NetEase Music" "$(nm 'music.163.com')"
chk "14a namemap записывает совпадение самого длинного суффикса"         "app Deep"          "$(nm 'deep.cdn.example.com')"
chk "14b namemap записывает отнесение к категории"             "cat CDN"           "$(nm 'x.fastly.net')"
chk "14c namemap записывает резервный домен сайта"             "site unknownsite.org" "$(nm 'shop.unknownsite.org')"
chk "14d namemap не содержит посторонний хост"           ""                  "$(nm 'not.in.the.map')"
chk "14e ключ namemap нормализован в нижний регистр"         "app Meituan"       "$(nm 'www.meituan.com')"
# the catalogue was already read once; without new host names it must not grow
nm_before=$(grep -c . "$T/state/namemap.tsv")

echo
echo "=== Временной ряд пропускной способности (два уровня) ==="
# every round records one point, so the two tiers must agree with the totals
chk "16 точки series10 согласованы с totals (приём)"  "66000" "$(awk -F'\t' '{s+=$2} END{print s+0}' "$T/state/series10.tsv")"
chk "16a точки series10 согласованы с totals (отдача)" "6600"  "$(awk -F'\t' '{s+=$3} END{print s+0}' "$T/state/series10.tsv")"
chk "16b записана хотя бы 1 точка выборки"             "yes"   "$(awk 'END{print (NR>=1)?"yes":"no"}' "$T/state/series10.tsv")"
chk "16c минутный аккумулятор выровнен по целой минуте"           "0"     "$(( $(sed -n '1p' "$T/state/minute.tsv") % 60 ))"

echo
echo "=== Изменение каталога должно инвалидировать кэш ==="
# Rewrite the application table (a different size, as a real upgrade would be)
# and point the suffix at a new name: the cached answer has to be replaced.
{
    printf 'NetEase Music\tmusic.163.com\tH\n'
    printf 'NetEase\t163.com\tS\n'
    printf 'Taobao\ttaobao.com\tS\n'
    printf 'Deep CDN\tcdn.example.com\tS\n'
    printf 'Example\texample.com\tS\n'
    printf 'Foo Bar UK\tbar.co.uk\tS\n'
    printf 'Example Org\texample.org\tS\n'
    printf 'Meituan\tmeituan.com\tS\n'
    printf 'Fastly\tfastly.net\tS\n'
} > "$T/apps.tsv"
# also stage a finished minute, so the next run has to fold it into the day tier
printf '%s\n%s\n%s\n' "$(( $(date +%s) / 60 * 60 - 60 ))" 4242 424 > "$T/state/minute.tsv"
run_collector 30
chk "15 после изменения каталога namemap разрешает заново"       "app Fastly"        "$(nm 'x.fastly.net')"
chk "15a после изменения каталога длинный суффикс разрешается заново"         "app Deep CDN"      "$(nm 'deep.cdn.example.com')"
chk "15b кэш не дописан повторно"                 "$nm_before"        "$(grep -c . "$T/state/namemap.tsv")"
# Asserting that the seeded minute is present, rather than that it is the last
# row: if the run happens to span a real minute boundary the collector also
# flushes the minute that just ended, so the seeded row is no longer last.  That
# took a few percent of runs to fail, which is not a property worth asserting.
chk "17 после смены минуты предыдущая минута записана в series60"     "1"                 "$(awk -F'\t' '$2==4242 && $3==424 { n++ } END { print n + 0 }' "$T/data/series60.tsv")"
chk "17a series60 хранит только полные минуты"          "0"                 "$(( $(awk -F'\t' 'END{print $1}' "$T/data/series60.tsv") % 60 ))"
# the conntrack snapshot is unchanged since the first run, so these rounds carry
# no traffic at all - and a quiet round must still get a point, otherwise the
# chart would show a hole instead of zero
chk "17b цикл без трафика записан нулевой точкой"            "yes"               "$(awk -F'\t' '$2=="0" && $3=="0" {print "yes"; exit}' "$T/state/series10.tsv" | grep -q . && echo yes || echo no)"

echo
echo "=== Ограничение окна холодных данных ==="
# shrink the day tier to 3 points and pre-fill it: the oldest must be dropped
printf '1\t1\t1\n2\t2\t2\n3\t3\t3\n4\t4\t4\n5\t5\t5\n' > "$T/data/series60.tsv"
printf '%s\n%s\n%s\n' "$(( $(date +%s) / 60 * 60 - 60 ))" 77 7 > "$T/state/minute.tsv"
run_collector 30 TRAFFIC_SERIES_COLD=180
chk "18 series60 обрезан до предела (3 точки)"       "3"                 "$(grep -c . "$T/data/series60.tsv")"
# Same reasoning as 17: the invariant is that trimming dropped the oldest
# points, not which row happens to be last when the run spans a minute boundary.
chk "18a сохранены новые точки, а не старые"         "0"                 "$(awk -F'\t' '($2==1 && $3==1) || ($2==2 && $3==2) { n++ } END { print n + 0 }' "$T/data/series60.tsv")"

# an idle minute is data too: skipping it would compress the chart's time axis,
# because the points are spaced by index.  A minute of its own (-120) keeps the
# point distinct from the one phase 18 wrote when both runs happen inside the
# same wall-clock minute.
printf '%s\n%s\n%s\n' "$(( $(date +%s) / 60 * 60 - 120 ))" 0 0 > "$T/state/minute.tsv"
run_collector 30 TRAFFIC_SERIES_COLD=180
chk "18b простаивающая минута всё равно записывается"             "0/0"               "$(awk -F'\t' 'END{print $2"/"$3}' "$T/data/series60.tsv")"
chk "18c простаивающие точки тоже ограничены окном"           "3"                 "$(grep -c . "$T/data/series60.tsv")"

echo
echo "=== Разрешение по запросу (страница не ждёт окно троттлинга) ==="
# a fresh resolve timestamp means the throttle would normally hold this host
# name back; the page asks for it now by dropping the flag
printf '%s\n' "$(date +%s)" > "$T/state/nmtime"
printf '192.168.2.138\tnewhost.meituan.com\t10.20.30.40\n' >> "$T/state/dnsmap.tsv"
printf '1\n' > "$T/state/pending"
# The throttle window has to outlast the run or this phase cannot mean anything.
# CFG_RESOLVE defaults to 30 and run_collector was asked for 30 seconds, so the
# window expired while the collector was still running and the name resolved -
# the assertion expected the opposite and had presumably been red since the day
# it was written.  Widening the window to an hour makes the run sit well inside
# it, so "the throttle held the name back" is a statement about the throttle and
# not about how long this phase happened to take.
run_collector 30 TRAFFIC_RESOLVE=3600
chk "19 троттлинг работает: новое имя хоста пока не разрешается"        ""                  "$(nm 'newhost.meituan.com')"
chk "19a число ожидающих разрешения передаётся"                 "1"                 "$(sed -n '1p' "$T/state/pending")"
: > "$T/state/resolve.now"
# resolve.now has to beat the throttle, so it is checked against the same wide
# window that just held the name back
run_collector 30 TRAFFIC_RESOLVE=3600
chk "19b resolveNow сразу даёт странице имя"    "app Meituan"       "$(nm 'newhost.meituan.com')"
chk "19c флаг очищается после использования"                 "no"                "$( [ -f "$T/state/resolve.now" ] && echo yes || echo no )"
chk "19d после разрешения счётчик ожидающих равен нулю"             "0"                 "$(sed -n '1p' "$T/state/pending")"

echo
echo "=== Собственные адреса роутера не считаются клиентом ==="
# The box runs a proxy, so its own LAN address sources a pile of outbound
# connections.  Counted as a client, "192.168.2.1" sat at the top of the list
# with 39 MB against it, and the same for its v6 address.  A real v6 client is
# in the fixture too, so passing here cannot be explained by the LAN-prefix rule
# rather than by the self set: .0050 must be counted, .0001 must not.
mkdir -p "$T/state2" "$T/data2"
cat > "$T/ct2" <<'EOF'
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.50 dst=1.1.1.1 sport=2001 dport=443 packets=1 bytes=100 tos=0 src=1.1.1.1 dst=192.168.2.50 sport=443 dport=2001 packets=1 bytes=1000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv4 2 tcp 6 119 ESTABLISHED src=192.168.2.1 dst=2.2.2.2 sport=2002 dport=443 packets=1 bytes=200 tos=0 src=2.2.2.2 dst=192.168.2.1 sport=443 dport=2002 packets=1 bytes=2000 tos=0 [ASSURED] mark=0 zone=0 use=2
ipv6 2 tcp 6 119 ESTABLISHED src=fdc8:64ed:f962:0000:0000:0000:0000:0001 dst=2400:3200:0000:0000:0000:0000:0000:0001 sport=2003 dport=443 packets=1 bytes=300 tos=0 src=2400:3200:0000:0000:0000:0000:0000:0001 dst=fdc8:64ed:f962:0000:0000:0000:0000:0001 sport=443 dport=2003 packets=1 bytes=3000 tos=0 [ASSURED] mark=0 use=1
ipv6 2 tcp 6 119 ESTABLISHED src=fdc8:64ed:f962:0000:0000:0000:0000:0050 dst=2400:3200:0000:0000:0000:0000:0000:0002 sport=2004 dport=443 packets=1 bytes=400 tos=0 src=2400:3200:0000:0000:0000:0000:0000:0002 dst=fdc8:64ed:f962:0000:0000:0000:0000:0050 sport=443 dport=2004 packets=1 bytes=4000 tos=0 [ASSURED] mark=0 use=1
EOF
run_collector_at 30 "$T/state2" "$T/data2" "$T/ct2" /nonexistent \
    TRAFFIC_SELF="192.168.2.1 fdc8:64ed:f962:0000:0000:0000:0000:0001" \
    TRAFFIC_LAN6=fdc8:64ed:f962:
c2() { awk -F'\t' -v ip="$1" '$1==ip {print $2}' "$T/state2/clients.tsv"; }
chk "20 собственный v4-адрес роутера не считается клиентом"     ""                  "$(c2 '192.168.2.1')"
chk "20a собственный v6-адрес роутера не считается клиентом"    ""                  "$(c2 'fdc8:64ed:f962:0000:0000:0000:0000:0001')"
chk "20b v6-клиент по-прежнему учитывается"                 "4400"              "$(c2 'fdc8:64ed:f962:0000:0000:0000:0000:0050')"
chk "20c v4-клиент по-прежнему учитывается"                 "1100"              "$(c2 '192.168.2.50')"
chk "20d клиентов ровно два"                    "2"                 "$(grep -c . "$T/state2/clients.tsv")"
chk "20e собственный трафик относится к router, а не к клиентам"    "5500"              "$(cat "$T/state2/router.tsv")"
chk "20f снимок не указывает собственный адрес как клиента"        "0"                 "$(grep -o '"ip":"192.168.2.1"' "$T/state2/summary.json" 2>/dev/null | wc -l | tr -d ' ')"
chk "20g снимок сообщает собственные адреса (видны на странице)"      "192.168.2.1 fdc8:64ed:f962:0000:0000:0000:0000:0001" \
    "$(grep -o '"self":"[^"]*"' "$T/state2/summary.json" 2>/dev/null | cut -d'"' -f4)"

echo
echo "=== После смены версии состояния счётчики пересоздаются ==="
# /tmp/traffic survives an upgrade, so the row that used to be the box's own
# address is already in clients.tsv - and a running total is only ever added to,
# so it would sit at the top of the client list forever.  An older schema forces
# a rebuild; the same schema must not, or every restart would wipe the counters.
mkdir -p "$T/state3" "$T/data3"
printf '192.168.2.1\t39587169\n' > "$T/state3/clients.tsv"
printf '999\n' > "$T/state3/version"
run_collector_at 30 "$T/state3" "$T/data3" "$T/ct" "$T/ql"
c3() { awk -F'\t' -v ip="$1" '$1==ip {print $2}' "$T/state3/clients.tsv"; }
chk "21 старые строки клиентов удалены"         ""                  "$(c3 '192.168.2.1')"
chk "21a новый номер версии записан"                    "$SCHEMA"                 "$(sed -n '1p' "$T/state3/version")"
chk "21b счётчики пересозданы из новых данных"            "72600"             "$(c3 '192.168.2.138')"
# second run: the schema now matches, so the totals must survive it untouched
run_collector_at 30 "$T/state3" "$T/data3" "$T/ct" "$T/ql"
chk "21c при неизменной версии счётчики не очищаются"          "72600"             "$(c3 '192.168.2.138')"

echo
echo "=== Автоопределение собственных адресов роутера (реальный путь устройства) ==="
# Nobody sets 'self' by hand: on the router the collector finds the addresses
# itself, which is the path the field report came from and the one that has to
# keep working.  A stub 'ip' stands in for the LAN interface, link-local
# address included, because 'ip -6 addr show' prints one.
mkdir -p "$T/fakebin" "$T/state4" "$T/data4"
cat > "$T/fakebin/ip" <<'EOF'
#!/bin/sh
case "$*" in
    "-4 addr show dev br-lan")
        printf '    inet 192.168.2.1/24 brd 192.168.2.255 scope global br-lan\n' ;;
    "-6 addr show dev br-lan")
        printf '    inet6 fdc8:64ed:f962::1/64 scope global\n'
        printf '    inet6 fe80::1/64 scope link\n' ;;
esac
EOF
chmod +x "$T/fakebin/ip"
# no TRAFFIC_SELF and no TRAFFIC_LAN6: both are detected through the stub
run_collector_at 30 "$T/state4" "$T/data4" "$T/ct2" /nonexistent "PATH=$T/fakebin:$PATH"
c4() { awk -F'\t' -v ip="$1" '$1==ip {print $2}' "$T/state4/clients.tsv"; }
chk "22 LAN-адрес определён автоматически и исключён"          ""                  "$(c4 '192.168.2.1')"
chk "22a v6-адрес определён автоматически и исключён"          ""                  "$(c4 'fdc8:64ed:f962:0000:0000:0000:0000:0001')"
chk "22b v6-клиент не затронут"                 "4400"              "$(c4 'fdc8:64ed:f962:0000:0000:0000:0000:0050')"
chk "22c найденные адреса записаны в снимок (v4+v6, v6 развёрнут)" \
    "192.168.2.1 fdc8:64ed:f962:0000:0000:0000:0000:0001 fe80:0000:0000:0000:0000:0000:0000:0001" \
    "$(grep -o '"self":"[^"]*"' "$T/state4/summary.json" 2>/dev/null | cut -d'"' -f4)"
chk "22d при автоопределении собственный трафик всё равно относится к router"     "5500"              "$(cat "$T/state4/router.tsv")"

echo
echo "=== Побайтовый учёт по клиентам (nft) ==="
# The counters are what makes the client totals independent of the conntrack
# table.  A stub nft stands in for the kernel: it remembers which chains and
# rules were added and prints the byte counters the test sets, so rule building,
# reading, the delta and the rebuild after a firewall reload are all exercised
# offline.
mkdir -p "$T/fakebin" "$T/nft5" "$T/state5" "$T/data5"
cat > "$T/fakebin/nft" <<'EOF'
#!/bin/sh
# The table is always "<family> traffic_acct", so the chain name is the fifth
# argument for every call shape the collector uses.
S=${NFTS:?}
mkdir -p "$S"
case "$1" in
    add)
        case "$2" in
            table) : ;;
            chain) : > "$S/rules.$5" ;;
            rule)
                ch="$5"; shift 5
                printf '%s\n' "$*" >> "$S/rules.$ch" ;;
        esac ;;
    flush)
        [ "$2" = chain ] && : > "$S/rules.$5" ;;
    list)
        ch="$5"
        [ -f "$S/rules.$ch" ] || exit 1
        printf 'table inet traffic_acct {\n\tchain %s {\n' "$ch"
        while read -r line; do
            [ -n "$line" ] || continue
            a=$(printf '%s\n' "$line" | awk '{ for (i = 1; i <= NF; i++) if ($i == "saddr" || $i == "daddr") print $(i + 1) }')
            b=$(awk -v a="$a" '$1 == a { print $2 }' "$S/counters.$ch" 2>/dev/null)
            [ -n "$b" ] || b=0
            printf '\t\t%s counter packets 1 bytes %s\n' "$line" "$b"
        done < "$S/rules.$ch"
        printf '\t}\n}\n' ;;
esac
exit 0
EOF
chmod +x "$T/fakebin/nft"
# Windows ships a `timeout` that waits for a key rather than running a
# command, and on this machine /c/WINDOWS/system32 comes first in PATH, so
# `command -v timeout` resolved to it.  collector.sh's nft_run() then ran
# `timeout 5 nft ...`, nft never executed, and the whole counter layer
# degraded silently: "acct":0 and no rules.pre.  BusyBox and coreutils both
# provide timeout, so this is a property of the test machine, not of the
# package - the suite supplies the POSIX contract it assumed.  It enforces a
# real bound rather than exec'ing blindly, so a wedged command still ends.
cat > "$T/fakebin/timeout" <<'EOF'
#!/bin/sh
set -u
secs="$1"; shift
"$@" &
cmd=$!
( sleep "$secs"; kill -9 "$cmd" 2>/dev/null ) &
killer=$!
wait "$cmd"; rc=$?
kill "$killer" 2>/dev/null
exit "$rc"
EOF
chmod +x "$T/fakebin/timeout"
# one live host, one more live host, and a stale arp entry that is not a client
cat > "$T/arp5" <<'EOF'
IP address       HW type     Flags       HW address            Mask     Device
192.168.2.50     0x1         0x2         aa:bb:cc:dd:ee:01     *        br-lan
192.168.2.51     0x1         0x2         aa:bb:cc:dd:ee:02     *        br-lan
192.168.2.99     0x1         0x0         00:00:00:00:00:00     *        br-lan
192.168.1.7      0x1         0x2         aa:bb:cc:dd:ee:03     *        br-lan
EOF
printf '192.168.2.50 1000\n192.168.2.51 0\n' > "$T/nft5/counters.pre"
printf '192.168.2.50 10000\n192.168.2.51 0\n' > "$T/nft5/counters.post"
run_collector_at 30 "$T/state5" "$T/data5" "$T/ct2" /nonexistent \
    "PATH=$T/fakebin:$PATH" "NFTS=$T/nft5" "TRAFFIC_ARPFILE=$T/arp5" \
    TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
chk "23 правила счётчиков создаются только для реальных соседей LAN"      "2"                 "$(grep -c 'saddr' "$T/nft5/rules.pre" 2>/dev/null)"
chk "23a для устаревших записей arp правила не создаются"           "0"                 "$(grep -c '192.168.2.99' "$T/nft5/rules.pre" 2>/dev/null)"
chk "23b для соседей из сети WAN правила не создаются"              "0"                 "$(grep -c '192.168.1.7' "$T/nft5/rules.pre" 2>/dev/null)"
# The cumulative per-client file is asserted rather than the per-round delta:
# the collector primes its baseline at startup, so by the time the runner has
# seen a completed round the delta of that first reading is already accounted
# and the delta file shows the (zero) change of the round itself.
chk "23c приём считается по адресу назначения (postrouting)"   "10000"             "$(awk -F'\t' '$1=="192.168.2.50"{print $2}' "$T/state5/acct.tsv")"
chk "23d отдача считается по адресу источника (prerouting)"      "1000"              "$(awk -F'\t' '$1=="192.168.2.50"{print $3}' "$T/state5/acct.tsv")"
chk "23e итог клиента берётся из счётчиков"              "11000"             "$(awk -F'\t' '$1=="192.168.2.50"{print $2}' "$T/state5/clients.tsv")"
chk "23f снимок сообщает, что уровень счётчиков включён"              "1"                 "$(grep -o '"acct":[0-9]*' "$T/state5/summary.json" | cut -d: -f2)"
# The Makefile substitutes the package version in at build time; here it is the
# unsubstituted placeholder, and that it is present at all is what matters: the
# page shows it so an installed fix can be told from one that is not running.
chk "23f2 снимок сообщает версию сборщика"               "dev"               "$(grep -o '"version":"[^"]*"' "$T/state5/summary.json" | cut -d'"' -f4)"
# client_bytes is the page's per-client denominator.  It is produced by its
# own awk over clients.tsv (column 2), separate from the top-clients array,
# so it is asserted against a sum this test computes itself: a change of
# file or of column in that awk now fails here instead of passing quietly.
# The reader must be totf: "accounted" carries only the nft counters' down/up,
# so asking acctf for client_bytes returns an empty string on every snapshot
# and the mismatch would read as a product bug rather than a lookup mistake.
totf() { grep -o '"totals":{[^}]*}' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }
chk "23f3 client_bytes равен сумме байтов клиентов"  "$(awk -F'\t' '{s+=$2} END{print s+0}' "$T/state5/clients.tsv")" \
                                            "$(totf "$T/state5/summary.json" client_bytes)"
# 23f3 can only tell column 2 from column 3 if the fixture makes them
# differ.  Without this guard, a fixture whose columns happen to be equal
# would let a wrong-column awk pass - the vacuous case to avoid.
chk "23f4 тестовые данные различают столбцы 2 и 3"            "different" \
    "$( [ "$(awk -F'\t' '{s+=$2} END{print s+0}' "$T/state5/clients.tsv")" != "$(awk -F'\t' '{s+=$3} END{print s+0}' "$T/state5/clients.tsv")" ] && echo different || echo same )"
acctf() { grep -o '"accounted":{[^}]*}' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }
chk "23g снимок сообщает итог счётчиков (приём)"        "10000"             "$(acctf "$T/state5/summary.json" down)"
chk "23g2 снимок сообщает итог счётчиков (отдача)"       "1000"              "$(acctf "$T/state5/summary.json" up)"
# Large byte counters must survive every TSV and JSON serialization step.
# A 32-bit awk printf %d clamps them to 2147483647 on the router.
mkdir -p "$T/large"
: > "$T/large/flow.state"
: > "$T/large/dnsmap.tsv"
printf 'Large App\t1000000000\t3000000000\nOther\t0\t0\n' > "$T/large/totals.tsv"
printf '192.168.2.50\t4000000000\n192.168.2.51\t1000000000\n' > "$T/large/clients.tsv"
printf 'Large App\t192.168.2.50\t3000000000\n' > "$T/large/ac.tsv"
printf '0\t0\t0\t0\n' > "$T/large/stat.tsv"
printf '0\n0\n' > "$T/large/wan.tsv"
sed '$d' "$COLLECTOR" > "$T/collector-functions.sh"
(
    . "$T/collector-functions.sh"
    STATE_DIR="$T/large"
    WAN_IF=
    ACCT_ON=0
    CFG_TOP_APPS=10
    CFG_TOP_CLIENTS=10
    TRAFFIC_LEASES=/nonexistent
    write_summary
)
chk "23g3 приём крупного приложения не обрезается" "3000000000" "$(grep -o '"name":"Large App","down":[0-9]*' "$T/large/summary.json" | cut -d: -f3)"
chk "23g4 отдача крупного приложения не обрезается" "1000000000" "$(grep -o '"name":"Large App"[^}]*"up":[0-9]*' "$T/large/summary.json" | sed -n 's/.*"up":\([0-9]*\).*/\1/p')"
chk "23g5 основной клиент крупного приложения не обрезается" "3000000000" "$(grep -o '"name":"Large App"[^}]*"top_bytes":[0-9]*' "$T/large/summary.json" | sed -n 's/.*"top_bytes":\([0-9]*\).*/\1/p')"
chk "23g6 крупный клиент не обрезается" "4000000000" "$(grep -o '"ip":"192.168.2.50"[^}]*"bytes":[0-9]*' "$T/large/summary.json" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
chk "23g7 итоговый приём не обрезается" "3000000000" "$(totf "$T/large/summary.json" down)"
chk "23g8 сумма клиентов не обрезается" "5000000000" "$(totf "$T/large/summary.json" client_bytes)"
# second round: only the increase is added, not the absolute counter again
printf '192.168.2.50 3000\n192.168.2.51 0\n' > "$T/nft5/counters.pre"
printf '192.168.2.50 25000\n192.168.2.51 0\n' > "$T/nft5/counters.post"
run_collector_at 30 "$T/state5" "$T/data5" "$T/ct2" /nonexistent \
    "PATH=$T/fakebin:$PATH" "NFTS=$T/nft5" "TRAFFIC_ARPFILE=$T/arp5" \
    TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
chk "23h прирост накапливается, а не абсолютное значение повторно"      "3000"              "$(awk -F'\t' '$1=="192.168.2.50"{print $3}' "$T/state5/acct.tsv")"
# A new client must not reset the counters that are already running: flushing
# and rebuilding the rule set on any neighbour change would throw away the
# traffic of the interval the rebuild happened in, and neighbour entries expire
# and come back all the time.
cat >> "$T/arp5" <<'EOF'
192.168.2.52     0x1         0x2         aa:bb:cc:dd:ee:04     *        br-lan
EOF
printf '192.168.2.50 13000\n192.168.2.51 0\n192.168.2.52 700\n' > "$T/nft5/counters.pre"
printf '192.168.2.50 35000\n192.168.2.51 0\n192.168.2.52 900\n' > "$T/nft5/counters.post"
run_collector_at 30 "$T/state5" "$T/data5" "$T/ct2" /nonexistent \
    "PATH=$T/fakebin:$PATH" "NFTS=$T/nft5" "TRAFFIC_ARPFILE=$T/arp5" \
    TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
chk "23h2 новый клиент не сбрасывает существующие счётчики"       "13000"             "$(awk -F'\t' '$1=="192.168.2.50"{print $3}' "$T/state5/acct.tsv")"
chk "23h3 новый клиент сразу начинает учитываться"           "700"               "$(awk -F'\t' '$1=="192.168.2.52"{print $3}' "$T/state5/acct.tsv")"
chk "23h4 для нового клиента тоже создано правило"               "3"                 "$(grep -c 'saddr' "$T/nft5/rules.pre" 2>/dev/null)"
# a firewall reload flushes the whole ruleset, ours included: the chains have to
# come back, and the counters restart from a lower value
rm -f "$T/nft5/rules.pre" "$T/nft5/rules.post"
printf '192.168.2.50 200\n192.168.2.51 0\n' > "$T/nft5/counters.pre"
printf '192.168.2.50 500\n192.168.2.51 0\n' > "$T/nft5/counters.post"
run_collector_at 30 "$T/state5" "$T/data5" "$T/ct2" /nonexistent \
    "PATH=$T/fakebin:$PATH" "NFTS=$T/nft5" "TRAFFIC_ARPFILE=$T/arp5" \
    TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
chk "23i после перезагрузки firewall правила счётчиков восстанавливаются"          "3"                 "$(grep -c 'saddr' "$T/nft5/rules.pre" 2>/dev/null)"
chk "23j после обнуления счётчиков прирост считается от нового значения"      "35500"             "$(awk -F'\t' '$1=="192.168.2.50"{print $2}' "$T/state5/acct.tsv")"
chk "23k накопленное значение продолжается от предыдущих циклов"        "13200"             "$(awk -F'\t' '$1=="192.168.2.50"{print $3}' "$T/state5/acct.tsv")"
# without nft the client totals fall back to conntrack, and the snapshot says so
run_collector_at 30 "$T/state6" "$T/data6" "$T/ct" "$T/ql" TRAFFIC_SELF="192.168.2.1"
chk "23l без nft выполняется откат с честным сообщением"           "0"                 "$(grep -o '"acct":[0-9]*' "$T/state6/summary.json" | cut -d: -f2)"
chk "23m причина отката записана в снимок"                  "nft is not installed" "$(grep -o '"acct_error":"[^"]*"' "$T/state6/summary.json" | cut -d'"' -f4)"
chk "23n при откате итог клиентов всё равно берётся из conntrack" "72600"           "$(awk -F'\t' '$1=="192.168.2.138"{print $2}' "$T/state6/clients.tsv")"

echo
echo "=== Структура снимка (поля, которые читает страница, должны быть здесь) ==="
# A field written into the wrong nesting level is invisible: rpcd only checks
# that the file starts with a brace, and the page simply reads undefined.  The
# whole status strip lost its rows that way once, so the shape is asserted
# rather than assumed.  awk is used so the suite keeps working without node.
shape() {
    # top-level keys only: strip everything inside the nested objects/arrays
    sed -e 's/,"apps":\[.*$//' -e 's/^[^{]*{//' "$1" \
        | tr ',' '\n' | sed -n 's/^"\([a-z_]*\)":.*/\1/p'
}
chk "25 снимок — корректный JSON (первый символ)"          "{"                 "$(head -c 1 "$T/state5/summary.json")"
chk "25a метаданные на верхнем уровне: version"             "version"           "$(shape "$T/state5/summary.json" | grep -x version)"
chk "25b метаданные на верхнем уровне: acct"                "acct"              "$(shape "$T/state5/summary.json" | grep -x acct)"
chk "25c метаданные на верхнем уровне: self"                "self"              "$(shape "$T/state5/summary.json" | grep -x self)"
chk "25d метаданные на верхнем уровне: pending"             "pending"           "$(shape "$T/state5/summary.json" | grep -x pending)"
chk "25e итог по-прежнему внутри totals"                "1"                 "$(grep -c '"totals":{"down"' "$T/state5/summary.json")"
chk "25f метаданные не попали в totals"             "0"                 "$(sed -n 's/.*"totals":{\([^}]*\)}.*/\1/p' "$T/state5/summary.json" | grep -c '"version"')"
# a snapshot that does not parse is worse than one that is empty, and node is
# not available on the target, so balance is checked the cheap way
chk "25g кавычки парные (чётное число двойных кавычек)"          "0"                 "$(( $(tr -cd '"' < "$T/state5/summary.json" | wc -c) % 2 ))"
# A snapshot written before the first round means "no snapshot" can only mean
# the service is not running; without it, a collector stuck in round one looks
# exactly like one that never started.
chk "25h счётчик циклов есть в снимке"                "1"                 "$(grep -c '"rounds":[0-9]' "$T/state5/summary.json")"
mkdir -p "$T/state8" "$T/data8"
( UCI=/bin/true LUA="$T/bin/lua" CT="$T/ct" TRAFFIC_QUERYLOG="$T/ql" TRAFFIC_LAN4=192.168.2. \
  TRAFFIC_INTERVAL=30 TRAFFIC_DATADIR="$T/data8" TRAFFIC_APPMAP="$T/apps.tsv" \
  TRAFFIC_CATEGORIES="$T/categories.tsv" STATE_DIR="$T/state8" \
  SELF_DIR="$(cd "$SELF/../root/usr/share/traffic" && pwd)" \
  sh "$COLLECTOR" >/dev/null 2>&1 ) &
stpid=$!
i=0
while [ "$i" -lt 40 ]; do
  [ -s "$T/state8/summary.json" ] && break
  sleep 0.2; i=$((i + 1))
done
chk "25i снимок записывается при старте (до первого цикла)"      "0"                 "$(rounds_at "$T/state8/summary.json")"
chk "25j стартовый снимок уже содержит версию и собственные адреса"        "yes"               "$(grep -q '"version":"' "$T/state8/summary.json" && grep -q '"self":"' "$T/state8/summary.json" && echo yes || echo no)"
kill $stpid 2>/dev/null; wait $stpid 2>/dev/null

echo
echo "=== Журнал запросов dnsmasq как второй источник доменов ==="
# On a router where passwall has taken dnsmasq over, the proxied domains are
# answered by passwall and never reach AdGuard Home, and the queries AdGuard
# does see arrive from dnsmasq instead of from the device.  dnsmasq's own log has
# both the device address and those domains.
mkdir -p "$T/state7" "$T/data7"
cat > "$T/dnsmasq.log" <<'EOF'
Aug 10 12:00:00 router daemon.info dnsmasq[1234]: query[A] www.youtube.com from 192.168.2.50
Aug 10 12:00:00 router daemon.info dnsmasq[1234]: reply www.youtube.com is 142.250.185.78
Aug 10 12:00:01 router daemon.info dnsmasq[1234]: query[AAAA] www.youtube.com from 192.168.2.50
Aug 10 12:00:01 router daemon.info dnsmasq[1234]: reply www.youtube.com is <CNAME>
Aug 10 12:00:02 router daemon.info dnsmasq[1234]: query[A] cdn.example.net from 192.168.2.51
Aug 10 12:00:02 router daemon.info dnsmasq[1234]: forwarded cdn.example.net to 127.0.0.1
Aug 10 12:00:03 router daemon.info dnsmasq[1234]: cached cdn.example.net is 203.0.113.9
Aug 10 12:00:04 router daemon.info dnsmasq[1234]: query[A] bad.example.org from 192.168.2.50
Aug 10 12:00:04 router daemon.info dnsmasq[1234]: reply bad.example.org is NODATA
EOF
run_collector_at 30 "$T/state7" "$T/data7" "$T/ct2" /nonexistent \
    "TRAFFIC_DNSLOG=$T/dnsmasq.log" TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
d7() { awk -F'\t' -v d="$1" '$2==d {print $1" "$3}' "$T/state7/dnsmap.tsv"; }
chk "24 из журнала dnsmasq получены клиент и домен"    "192.168.2.50 142.250.185.78" "$(d7 'www.youtube.com')"
chk "24a строки cached тоже считаются ответом"             "192.168.2.51 203.0.113.9"   "$(d7 'cdn.example.net')"
chk "24b строки CNAME не считаются адресом"                  "0"                 "$(grep -c 'CNAME' "$T/state7/dnsmap.tsv" 2>/dev/null)"
chk "24c строки NODATA не считаются адресом"                 "0"                 "$(grep -c 'NODATA' "$T/state7/dnsmap.tsv" 2>/dev/null)"
chk "24d строки forwarded (адрес upstream) не считаются ответом"  "0"                 "$(grep -c '	127.0.0.1$' "$T/state7/dnsmap.tsv" 2>/dev/null)"
chk "24e домен нормализован в нижний регистр"                "192.168.2.50 142.250.185.78" "$(d7 'www.youtube.com')"
# incremental: only what is new is read, so a repeated run must not duplicate
before=$(grep -c . "$T/state7/dnsmap.tsv")
cat >> "$T/dnsmasq.log" <<'EOF'
Aug 10 12:00:09 router daemon.info dnsmasq[1234]: query[A] news.example.com from 192.168.2.51
Aug 10 12:00:09 router daemon.info dnsmasq[1234]: reply news.example.com is 198.51.100.7
EOF
run_collector_at 30 "$T/state7" "$T/data7" "$T/ct2" /nonexistent \
    "TRAFFIC_DNSLOG=$T/dnsmasq.log" TRAFFIC_SELF="192.168.2.1" TRAFFIC_LAN6=fdc8:64ed:f962:
chk "24f читается только новая часть"                    "$((before + 1))"  "$(grep -c . "$T/state7/dnsmap.tsv")"
chk "24g домены из нового фрагмента тоже получены"              "192.168.2.51 198.51.100.7" "$(d7 'news.example.com')"

echo
echo "=== Почасовой пересчёт: hourly.tsv и series1h.tsv ==="
# roll_hour is the only writer of both files, and it runs when the hour string
# changes - which a test cannot wait for.  A date stub that serves the hour from
# a file makes the rollover happen on demand while every other date call (the
# epoch a sample is stamped with) still goes to the real clock.
REALDATE=$(command -v date)
mkdir -p "$T/bin" "$T/state9" "$T/data9"
printf '%s\n' "$SCHEMA" > "$T/state9/version"   # matching schema, so what is seeded stays
printf 'YouTube\t1000\t5000\n' > "$T/state9/totals.tsv"   # name, up, down
printf '192.168.2.99\t6000\n'  > "$T/state9/clients.tsv"
printf '777\n'                 > "$T/state9/router.tsv"
# The device counters for this phase, and the device itself.  roll_hour now
# archives the WAN counters as its own kind of row, so this phase has to have a
# device: without one iface_account writes nothing and the archived device row
# would be missing for a reason that has nothing to do with the code under test.
# The counters never move, so every round contributes a delta of zero and the
# one hour this phase archives carries exactly the seeded session total.
printf '4000\n900\n'           > "$T/state9/wan.tsv"
cat > "$T/netdev9" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000       10    0    0    0     0          0         0     1000       10    0    0    0     0       0          0
  eth2: 5000000     4000    0    0    0     0          0         0   800000     3000    0    0    0     0       0          0
EOF
printf 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' > "$T/route9"
printf 'eth2\t00000000\t0102A8C1\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' >> "$T/route9"
printf 'h0\n' > "$T/fakehour"
cat > "$T/bin/date" <<EOF
#!/bin/sh
case "\$1" in
    +%Y-%m-%dT%H) cat "$T/fakehour" 2>/dev/null ;;
    *) exec "$REALDATE" "\$@" ;;
esac
EOF
chmod +x "$T/bin/date"
: > "$T/ctempty"

wait_rounds() {
    local st="$1" want="$2" i=0 at
    while [ "$i" -lt 150 ]; do
        at=$(rounds_at "$st/summary.json")
        case "$at" in ''|*[!0-9]*) at=0 ;; esac
        [ "$at" -ge "$want" ] && return 0
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}

# env, not a bare assignment prefix: this shell does not treat a quoted
# "NAME=value" word as an assignment, so the prefix form only works unquoted -
# and the device paths have to be quoted because they are built from $T.
env PATH="$T/bin:$PATH" UCI=/bin/true LUA="$T/bin/lua" CT="$T/ctempty" \
  TRAFFIC_QUERYLOG=/nonexistent TRAFFIC_LAN4=192.168.2. TRAFFIC_INTERVAL=2 \
  TRAFFIC_DATADIR="$T/data9" TRAFFIC_APPMAP="$T/apps.tsv" \
  TRAFFIC_CATEGORIES="$T/categories.tsv" STATE_DIR="$T/state9" \
  "TRAFFIC_PROC_NET_DEV=$T/netdev9" "TRAFFIC_PROC_NET_ROUTE=$T/route9" \
  TRAFFIC_PROC_NET_ROUTE6=/nonexistent \
  SELF_DIR="$(cd "$SELF/../root/usr/share/traffic" && pwd)" \
  sh "$COLLECTOR" >/dev/null 2>&1 &
hpid=$!
# One round in the old hour, then turn the clock over and let it roll once.
wait_rounds "$T/state9" 1
printf 'h1\n' > "$T/fakehour"
wait_rounds "$T/state9" 3
# A second rollover with no traffic in between.  The history has to gain its
# point but not a second copy of the bytes the first roll already archived, and
# the live counters have to survive it untouched - that difference is the whole
# point of snapshotting and differencing instead of resetting.
printf 'h2\n' > "$T/fakehour"
wait_rounds "$T/state9" 5
kill "$hpid" 2>/dev/null
wait "$hpid" 2>/dev/null
sleep 0.3

h9="$T/data9/hourly.tsv"
# The archived row is <hour>\t<kind>\t<name>\t<down>\t<up>, which is the layout the
# backend reads.  Seeded asymmetrically on purpose: equal numbers would hide a
# swap, and a swap is exactly what this asserts against.
chk "26 в почасовой строке приложения приём/отдача не перепутаны"              "5000/1000" "$(awk -F'\t' '$2=="app"    && $3=="YouTube" { printf "%s/%s", $4, $5 }' "$h9")"
chk "26a почасовая строка клиента записывает байты"              "6000/0"    "$(awk -F'\t' '$2=="client" { printf "%s/%s", $4, $5 }' "$h9")"
chk "26b почасовая строка туннеля записывает трафик самого роутера"        "777"       "$(awk -F'\t' '$2=="router" { printf "%s", $4 }' "$h9")"
chk "26c почасовой архив выполняется один раз"                    "1"         "$(awk -F'\t' '$2=="router"' "$h9" | wc -l | tr -d ' ')"
chk "26d число строк архива = по одной на четыре типа"             "4"         "$(grep -c . "$h9")"
# The device counters of the hour, as a fourth kind of row.  The archive's app
# rows are the attribution, which under flow offloading is a small fraction of
# what the box carried - so a range view totals from this row instead, and it has
# to be the seed and not the attribution.  Seeded asymmetrically again, and the
# app row above is 5000/1000, so a row that had been filled from the attribution
# would fail this even if the columns were right.
chk "26d1 почасовая строка интерфейса записывает байты устройства"             "4000/900"  "$(awk -F'\t' '$2=="wan" { printf "%s/%s", $4, $5 }' "$h9")"
chk "26d2 строка интерфейса имеет тип wan и имя-заглушку"        "wan/-"     "$(awk -F'\t' '$2=="wan" { printf "%s/%s", $2, $3 }' "$h9")"
chk "26d3 строка интерфейса относится к пересчитанному часу"           "1"         "$(awk -F'\t' '$1=="h1" && $2=="wan"' "$h9" | wc -l | tr -d ' ')"
# The row is a total and not an application.  A writer that emitted it as an app
# row instead would put a "-" entry in the application table of every range view.
chk "26d4 строка интерфейса не выдаёт себя за приложение"               "0"         "$(awk -F'\t' '$2=="app" && $3=="-"' "$h9" | wc -l | tr -d ' ')"
chk "26d5 накопленное за сессию по интерфейсу не очищено архивом"         "4000/900"  "$(sed -n '1p' "$T/state9/wan.tsv")/$(sed -n '2p' "$T/state9/wan.tsv")"
# The device baseline the next delta is measured against.  It is advanced by the
# roll, and it is what makes the second roll below archiving nothing rather than
# the same bytes twice.
chk "26d6 почасовой пересчёт продвинул снимок интерфейса"               "4000/900"  "$(sed -n '1p' "$T/state9/arch/wan.snap")/$(sed -n '2p' "$T/state9/arch/wan.snap")"
# The week tier is one point per hour, and its down column carries the router
# total as well, because the box's own traffic belongs to the hour too.
chk "26e series1h: приём включает трафик роутера"         "5777"      "$(cut -f2 "$T/data9/series1h.tsv" | head -n 1)"
chk "26f series1h: отдача"                     "1000"      "$(cut -f3 "$T/data9/series1h.tsv" | head -n 1)"
chk "26g series1h: одна точка за каждый пересчёт"           "2"         "$(grep -c . "$T/data9/series1h.tsv")"
chk "26h series1h: час без трафика равен 0"         "0/0"       "$(sed -n '2p' "$T/data9/series1h.tsv" | cut -f2,3 | tr '\t' '/')"
# The second roll had nothing new to archive, and the live counters it measured
# against are still there: zeroing them here is what used to make the page lose
# the session's traffic at the top of every hour.
chk "26i второй пересчёт не дублирует архив"              "4"         "$(grep -c . "$h9")"
# The device row has to obey the same rule as the router row: the second roll
# archived nothing, so the hour it ran in must not gain a copy of the bytes the
# first roll already recorded.  This is the assertion the snapshot exists for.
chk "26i1 второй пересчёт не дублирует строку интерфейса"       "1"         "$(awk -F'\t' '$2=="wan"' "$h9" | wc -l | tr -d ' ')"
chk "26i2 в часе второго пересчёта нет строки интерфейса"       "0"         "$(awk -F'\t' '$1=="h2" && $2=="wan"' "$h9" | wc -l | tr -d ' ')"
chk "26i3 после второго пересчёта снимок сохраняет прежнее значение"         "4000/900"  "$(sed -n '1p' "$T/state9/arch/wan.snap")/$(sed -n '2p' "$T/state9/arch/wan.snap")"
chk "26j почасовой пересчёт больше не очищает накопленное по приложениям"              "5000"      "$(awk -F'\t' '$1=="YouTube"{print $3}' "$T/state9/totals.tsv")"
chk "26k почасовой пересчёт больше не очищает накопленное по роутеру"            "777"       "$(sed -n '1p' "$T/state9/router.tsv")"
# The hour in progress, in device counters, for the backend to publish on the
# bucket it appends.  After the roll the session total and the snapshot are the
# same, so the current hour starts at zero rather than repeating the archived
# hour; a collector that published the session cumulative here instead would
# double every hour of every range once the hour turned over.
chk "26l текущий час публикует прирост интерфейса"          "0/0"       "$(sed -n '1p' "$T/state9/cur.iface")/$(sed -n '2p' "$T/state9/cur.iface")"
chk "26m прирост интерфейса берётся из разницы снимков, а не из накопленного за сессию"  "no" \
    "$([ "$(sed -n '1p' "$T/state9/cur.iface")" = "4000" ] && echo yes || echo no)"


echo
echo "=== Счётчики интерфейса WAN: авторитетный итог и кривая ==="
# Under flow offloading the attribution layer only sees a fraction of what the
# box carried - measured on the router, conntrack recorded 147 MiB while the WAN
# device carried 2579 MiB, 5.7% - so the totals, the series and the peak are
# taken from the WAN device's own counters instead.  Both the routing table that
# names the device and /proc/net/dev itself are overridable, which is what lets
# this run without a router.  eth2 carries rx=5000000, tx=800000.
#
# Every phase here is deterministic on purpose: the fake device counters never
# change, so a round contributes either the seeded difference or nothing at all,
# and the assertions hold however many rounds the collector manages to finish
# before it is stopped.
mkdir -p "$T/state10" "$T/data10" "$T/state11" "$T/data11" \
         "$T/state12" "$T/data12" "$T/state13" "$T/data13"
cat > "$T/netdev" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000       10    0    0    0     0          0         0     1000       10    0    0    0     0       0          0
  eth2: 5000000     4000    0    0    0     0          0         0   800000     3000    0    0    0     0       0          0
EOF
: > "$T/netdev-noif"
printf 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' > "$T/route"
printf 'eth2\t00000000\t0102A8C1\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' >> "$T/route"
NETW="TRAFFIC_PROC_NET_DEV=$T/netdev"
RTW="TRAFFIC_PROC_NET_ROUTE=$T/route"
NO6="TRAFFIC_PROC_NET_ROUTE6=/nonexistent"

# No explicit device setting: the default route is what names it, so this covers
# the /proc/net/route parse as well.
run_collector_at 30 "$T/state10" "$T/data10" "$T/ct2" /nonexistent "$NETW" "$RTW" "$NO6"
chk "27  устройство WAN определено по маршруту по умолчанию"            "eth2" \
    "$(sed -n 's/.*"iface":{"dev":"\([^"]*\)".*/\1/p' "$T/state10/summary.json")"
# The device has counted 5000000 bytes since it came up.  None of that is this
# session's traffic, and a first round that added it would publish a total the
# box never carried in the session being shown.
chk "27a первое чтение задаёт только базовую линию"             "0/0" \
    "$(sed -n 's/.*"iface":{[^}]*"down":\([0-9]*\),"up":\([0-9]*\).*/\1\/\2/p' "$T/state10/summary.json")"
chk "27b первое чтение не пишет отрицательных значений"                   "0" "$(grep -c -- '-' "$T/state10/wan.tsv")"

# The curve is the whole point of this fix: it has to be the traffic the box
# carried, because that is what a speed test looks like on the chart.  Its own
# device file is used so the bump below cannot disturb the phases around it, and
# the conntrack file for this phase is empty - so the attributed sample for a
# round is zero, and a series point that is not zero can only have come from the
# interface counters.  The device counters are bumped between two rounds, which
# makes the size of that point exactly the bump: the pass before the first round
# absorbs the starting values as its baseline, and round two is the only round
# that sees the change.
cat > "$T/netdev11" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth2: 5000000     4000    0    0    0     0          0         0   800000     3000    0    0    0     0       0          0
EOF
: > "$T/ctempty11"
env UCI=/bin/true LUA="$T/bin/lua" CT="$T/ctempty11" \
  TRAFFIC_QUERYLOG=/nonexistent TRAFFIC_LAN4=192.168.2. TRAFFIC_INTERVAL=2 \
  TRAFFIC_DATADIR="$T/data11" TRAFFIC_APPMAP="$T/apps.tsv" \
  TRAFFIC_CATEGORIES="$T/categories.tsv" STATE_DIR="$T/state11" \
  SELF_DIR="$(cd "$SELF/../root/usr/share/traffic" && pwd)" \
  "TRAFFIC_PROC_NET_DEV=$T/netdev11" "TRAFFIC_PROC_NET_ROUTE=$T/route" \
  TRAFFIC_PROC_NET_ROUTE6=/nonexistent \
  sh "$COLLECTOR" >/dev/null 2>&1 &
i11=$!
wait_rounds "$T/state11" 1
cat > "$T/netdev11" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth2: 5005000     4100    0    0    0     0          0         0   801000     3000    0    0    0     0       0          0
EOF
wait_rounds "$T/state11" 2
kill "$i11" 2>/dev/null
wait "$i11" 2>/dev/null
sleep 0.3
chk "27c итог сессии берётся из прироста счётчиков интерфейса"       "5000/1000" \
    "$(sed -n '1p' "$T/state11/wan.tsv")/$(sed -n '2p' "$T/state11/wan.tsv")"
chk "27d итог снимка берётся из счётчиков интерфейса"             "5000/1000" \
    "$(sed -n 's/.*"iface":{[^}]*"down":\([0-9]*\),"up":\([0-9]*\).*/\1\/\2/p' "$T/state11/summary.json")"
chk "27e точка кривой берётся из прироста интерфейса, а не из атрибуции"       "5000/1000" \
    "$(sed -n '2p' "$T/state11/series10.tsv" | cut -f2,3 | tr '\t' '/')"

# A counter that went backwards means the device was re-created.  Its new reading
# is traffic nothing has accounted for yet; what this guards against is arithmetic
# on unsigned values, which turns a negative difference into an enormous total.
# The version file has to match, or init_state() drops the seeded baseline as
# stale state and the phase would silently test the first-reading path instead.
printf '%s\n' "$SCHEMA" > "$T/state12/version"
printf '9999999\n9999999\n' > "$T/state12/wan.abs"
run_collector_at 30 "$T/state12" "$T/data12" "$T/ct2" /nonexistent "$NETW" "$RTW" "$NO6"
chk "27f после сброса счётчиков учёт идёт от нового значения"               "$(printf '5000000/800000')" \
    "$(sed -n '1p' "$T/state12/wan.tsv")/$(sed -n '2p' "$T/state12/wan.tsv")"
chk "27g после сброса счётчиков нет отрицательных значений"                 "0" "$(grep -c -- '-' "$T/state12/wan.tsv")"

# No device to measure: the key is not published at all, which is what the page
# reads as "fall back to the attributed numbers" rather than "the total is zero".
run_collector_at 30 "$T/state13" "$T/data13" "$T/ct2" /nonexistent \
    "TRAFFIC_PROC_NET_DEV=$T/netdev-noif" "TRAFFIC_WAN_IF=eth2" \
    "TRAFFIC_PROC_NET_ROUTE=/nonexistent" "$NO6"
chk "27h при отсутствии устройства iface не публикуется"           "0" "$(grep -c '"iface"' "$T/state13/summary.json")"
chk "27i при отсутствии устройства накопленное по интерфейсу не пишется"           "no" \
    "$([ -f "$T/state13/wan.tsv" ] && echo yes || echo no)"

# Whether the firewall offloads is always published, because it is what decides
# whether the attribution beside the total is a large share or a small one.
chk "27j снимок публикует состояние разгрузки"                   "0" \
    "$(sed -n 's/.*"offload":\([0-9]*\).*/\1/p' "$T/state10/summary.json")"

# The protocol buckets are the attribution's last resort, not applications: at
# about a third of the attributed traffic, listed among the applications they read
# as if an app called "SSL/TLS" had been used.
protoflag() {
    awk -v w="$1" 'BEGIN { RS = "{" }
        index($0, "\"name\":\"" w "\"") > 0 {
            print (index($0, "\"proto\":1") > 0) ? 1 : 0; exit
        }' "$2"
}
chk "27k протокольная корзина помечена proto"            "1" "$(protoflag 'SSL/TLS' "$T/state/summary.json")"
chk "27l реальное приложение не имеет метки proto"            "0" "$(protoflag 'NetEase Music' "$T/state/summary.json")"

# A device that disappears mid-session.  The delta of the round it vanished in
# must not sit on disk and be drawn again by every later round - with an empty
# conntrack file the fallback sample is zero, so a repeated 5000 would mean the
# stale delta was reused, and the session total would keep growing on a device
# nobody can measure any more.
cat > "$T/netdev14" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth2: 5000000     4000    0    0    0     0          0         0   800000     3000    0    0    0     0       0          0
EOF
env UCI=/bin/true LUA="$T/bin/lua" CT="$T/ctempty11" \
  TRAFFIC_QUERYLOG=/nonexistent TRAFFIC_LAN4=192.168.2. TRAFFIC_INTERVAL=2 \
  TRAFFIC_DATADIR="$T/data14" TRAFFIC_APPMAP="$T/apps.tsv" \
  TRAFFIC_CATEGORIES="$T/categories.tsv" STATE_DIR="$T/state14" \
  SELF_DIR="$(cd "$SELF/../root/usr/share/traffic" && pwd)" \
  "TRAFFIC_PROC_NET_DEV=$T/netdev14" "TRAFFIC_PROC_NET_ROUTE=$T/route" \
  TRAFFIC_PROC_NET_ROUTE6=/nonexistent \
  sh "$COLLECTOR" >/dev/null 2>&1 &
i14=$!
wait_rounds "$T/state14" 1
cat > "$T/netdev14" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth2: 5005000     4100    0    0    0     0          0         0   801000     3000    0    0    0     0       0          0
EOF
wait_rounds "$T/state14" 2
: > "$T/netdev14"
wait_rounds "$T/state14" 3
kill "$i14" 2>/dev/null
wait "$i14" 2>/dev/null
sleep 0.3
chk "27m после исчезновения устройства прирост прошлого цикла не переиспользуется"       "0/0" \
    "$(sed -n '3p' "$T/state14/series10.tsv" | cut -f2,3 | tr '\t' '/')"
chk "27n после исчезновения устройства итог сессии не растёт"         "5000/1000" \
    "$(sed -n '1p' "$T/state14/wan.tsv")/$(sed -n '2p' "$T/state14/wan.tsv")"

echo
if [ "$fail" = 0 ]; then echo "=== Все проверки пройдены ==="; else echo "=== Есть ошибки ==="; fi
exit "$fail"
