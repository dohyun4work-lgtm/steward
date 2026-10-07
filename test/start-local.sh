#!/usr/bin/env bash
# 로컬 테스트 스택: PostgreSQL 16(Supabase auth 흉내) + PostgREST + 테스트 서버
# 사용: bash test/start-local.sh [--reset]   (--reset: DB를 지우고 스키마 재적용)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
PGDIR=/var/tmp/pgtest; PGBIN=/usr/lib/postgresql/16/bin
WORK="${TASKHUB_WORK:-/var/tmp/taskhub-test}"; mkdir -p "$WORK"
PGRST="${POSTGREST_BIN:-$WORK/postgrest}"
if [ ! -x "$PGRST" ]; then
  curl -sSL -o "$WORK/pgrst.tar.xz" https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
  tar -xJf "$WORK/pgrst.tar.xz" -C "$WORK"
fi
mkdir -p $PGDIR && chown postgres $PGDIR
if [ ! -d $PGDIR/data ]; then su postgres -c "$PGBIN/initdb -D $PGDIR/data -A trust >/dev/null"; fi
rm -f $PGDIR/data/postmaster.pid
su postgres -c "$PGBIN/pg_ctl -D $PGDIR/data -o \"-k $PGDIR -c listen_addresses=''\" -l $PGDIR/log -w start" >/dev/null 2>&1 || true
q() { su postgres -c "psql -h $PGDIR -q $*"; }
q "-d postgres -c \"do \\\$\\\$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
end \\\$\\\$; grant anon, authenticated, service_role to authenticator;\""
# 실행 중인 서버를 먼저 내려야 DB를 지울 수 있음
pkill -f "postgrest $WORK/pgrst.conf" 2>/dev/null || true; pkill -f "node $HERE/server.js" 2>/dev/null || true
if [ "$1" = "--reset" ] || ! q "-d taskhub -c 'select 1'" >/dev/null 2>&1; then
  cp "$HERE/supabase-mock.sql" "$ROOT"/supabase/migrations/*.sql $PGDIR/ 2>/dev/null; chown postgres $PGDIR/*.sql
  q "-d postgres -c 'drop database if exists taskhub'"; q "-d postgres -c 'create database taskhub'"
  q "-d taskhub -v ON_ERROR_STOP=1 -f $PGDIR/supabase-mock.sql"; for m in "$ROOT"/supabase/migrations/*.sql; do q "-d taskhub -v ON_ERROR_STOP=1 -f $PGDIR/$(basename "$m")"; done
fi
cat > "$WORK/pgrst.conf" <<CONF
db-uri = "postgres://authenticator@/taskhub?host=$PGDIR"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "test-secret-test-secret-test-secret-32"
server-port = 3300
server-host = "127.0.0.1"
CONF
nohup "$PGRST" "$WORK/pgrst.conf" > "$WORK/pgrst.log" 2>&1 &
nohup node "$HERE/server.js" > "$WORK/server.log" 2>&1 &
sleep 2
curl -s -o /dev/null -w "PostgREST %{http_code} · " localhost:3300/ ; curl -s -o /dev/null -w "test server %{http_code}\n" localhost:4400/
