-- =====================================================================
-- Steward 007 — 구글 캘린더 오늘 일정 (읽기만, iCal 비공개 주소)
-- 설계: docs/calendar-design.md (A안)
--
-- · 비공개 주소는 Vault에만 저장 (steward_ical_<사용자 id>). 앱에는 다시 내려주지 않음
-- · 앱은 calendar_feeds에서 "연결됨 / 마지막 확인 / 오류"만 조회
-- · 일정 내용은 DB에 저장하지 않음. Edge Function calendar-today가 볼 때마다 Google에서 읽음
-- · 기존 테이블·함수는 바꾸지 않음. 여러 번 실행해도 안전
-- =====================================================================

create table if not exists public.calendar_feeds (
  user_id        uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  connected_at   timestamptz not null default now(),
  last_ok_at     timestamptz null,
  last_error     text        null,
  last_error_at  timestamptz null
);

alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from public, anon, authenticated;
grant select on public.calendar_feeds to authenticated;
grant select on public.calendar_feeds to service_role;
drop policy if exists calendar_feeds_select_own on public.calendar_feeds;
create policy calendar_feeds_select_own on public.calendar_feeds
  for select to authenticated using (user_id = (select auth.uid()));

-- 주소 저장 (앱). 구글 캘린더 「iCal 형식의 비공개 주소」만 받음
create or replace function public.set_calendar_feed(p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_url  text := btrim(coalesce(p_url, ''));
  v_name text;
  v_id   uuid;
begin
  if v_user is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if v_url !~ '^https://calendar\.google\.com/calendar/ical/[^/?#\s]+/private-[A-Za-z0-9]{16,}/basic\.ics$' then
    raise exception 'invalid calendar address' using errcode = '22023', hint = 'private_ical_only';
  end if;
  v_name := 'steward_ical_' || v_user::text;
  select s.id into v_id from vault.secrets s where s.name = v_name;
  if v_id is null then
    perform vault.create_secret(v_url, v_name, 'Steward: 구글 캘린더 비공개 주소 (calendar-today가 읽기만 함)');
  else
    perform vault.update_secret(v_id, v_url);
  end if;
  insert into public.calendar_feeds (user_id) values (v_user)
  on conflict (user_id) do update set connected_at = now(), last_ok_at = null, last_error = null, last_error_at = null;
end; $$;

-- 연결 해제 (앱): 주소와 상태를 모두 지움
create or replace function public.remove_calendar_feed()
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from vault.secrets s where s.name = 'steward_ical_' || v_user::text;
  delete from public.calendar_feeds f where f.user_id = v_user;
end; $$;

-- 주소 읽기 (Edge Function, service_role 전용)
create or replace function public.get_calendar_feed(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s
   where s.name = 'steward_ical_' || p_user::text
     and exists (select 1 from public.calendar_feeds f where f.user_id = p_user);
$$;

-- 읽기 결과 기록 (Edge Function, service_role 전용). 오류 문구에는 주소를 넣지 않음
create or replace function public.record_calendar_result(p_user uuid, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.calendar_feeds f
     set last_ok_at    = case when p_ok then now() else f.last_ok_at end,
         last_error    = case when p_ok then null else left(p_error, 200) end,
         last_error_at = case when p_ok then null else now() end
   where f.user_id = p_user;
$$;

revoke all on function public.set_calendar_feed(text), public.remove_calendar_feed(),
  public.get_calendar_feed(uuid), public.record_calendar_result(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_calendar_feed(text)                     to authenticated;
grant execute on function public.remove_calendar_feed()                      to authenticated;
grant execute on function public.get_calendar_feed(uuid)                     to service_role;
grant execute on function public.record_calendar_result(uuid, boolean, text) to service_role;
