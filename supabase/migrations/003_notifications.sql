-- =====================================================================
-- Steward 003 — 체크인 알림: 시간표·설정·기기 구독·발송 기록  (교차검토 반영 v2)
-- 설계: docs/checkin-design.md v2 (2번 테이블, 5번 설정, 7번 중복 방지·만료·재시도)
--
-- 역할 분리
--   앱(로그인 사용자) : 시간·요일·켜기/끄기 수정, 이 기기 구독 등록/해제, 알림 열람·완료 기록
--   Cron(DB 안)      : claim_due_checkins() — 보낼 알림을 선점 (004에서 예약)
--   Edge Function    : begin_sending → 기기별 발송 → record_push_result / finish_sending (service_role 전용)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 알림 시간표 (슬롯)
-- ---------------------------------------------------------------------
create table public.checkin_slots (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text        not null,
  local_time  time        not null,          -- 한국 시간
  weekdays    smallint[]  not null default '{0,1,2,3,4,5,6}',   -- 0=일 … 6=토
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint checkin_slots_kind_chk check (kind in ('morning','midday','evening','evening_final','review')),
  -- 5분 단위, 23:35까지 (발송 창 20분이 자정을 넘지 않게)
  constraint checkin_slots_time_chk check (extract(second from local_time) = 0
                                           and extract(minute from local_time)::int % 5 = 0
                                           and local_time <= time '23:35'),
  constraint checkin_slots_weekdays_chk check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(weekdays) > 0),
  constraint checkin_slots_time_uniq unique (user_id, local_time)          -- 같은 시각 두 슬롯 금지
);

-- ---------------------------------------------------------------------
-- 2. 전체 알림 설정 (사용자당 1행)
-- ---------------------------------------------------------------------
create table public.notification_prefs (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled    boolean     not null default true,
  timezone   text        not null default 'Asia/Seoul' check (timezone = 'Asia/Seoul'),   -- 지금은 고정
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. 기기별 푸시 구독
-- ---------------------------------------------------------------------
create table public.push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  endpoint        text        not null unique,              -- 같은 기기 중복 등록 방지 (7번 4겹)
  p256dh          text        not null,
  auth            text        not null,
  device_label    text        null check (device_label is null or char_length(device_label) <= 60),
  created_at      timestamptz not null default now(),
  last_success_at timestamptz null,
  failure_count   smallint    not null default 0,
  disabled_at     timestamptz null,
  constraint push_subscriptions_endpoint_https check (endpoint like 'https://%')
);

-- ---------------------------------------------------------------------
-- 4. 발송 기록 (중복 방지의 핵심)
-- ---------------------------------------------------------------------
create table public.notification_log (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users (id) on delete cascade,
  slot_id            uuid        not null references public.checkin_slots (id) on delete cascade,
  kind               text        not null,
  local_date         date        not null,                 -- 이 알림이 속한 한국 날짜
  due_at             timestamptz not null,                 -- 원래 보낼 시각 (시간 창 계산 기준)
  status             text        not null default 'claimed',
  claimed_at         timestamptz not null default now(),
  sending_started_at timestamptz null,
  next_attempt_at    timestamptz null,
  sent_at            timestamptz null,
  attempts           smallint    not null default 1,       -- 선점 횟수 (최대 3)
  devices_sent       smallint    not null default 0,
  error              text        null,
  opened_at          timestamptz null,
  completed_at       timestamptz null,
  constraint notification_log_status_chk check (status in ('claimed','sending','sent','partial','failed','unknown','expired')),
  constraint notification_log_slot_day_uniq unique (slot_id, local_date)     -- 7번 1겹: 슬롯·날짜당 한 번
);

create index notification_log_pending_idx on public.notification_log (status, next_attempt_at) where status in ('claimed','sending','failed');
create index notification_log_user_day_idx on public.notification_log (user_id, local_date);
create index push_subscriptions_user_active_idx on public.push_subscriptions (user_id) where disabled_at is null;

-- updated_at 자동 갱신
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
create trigger checkin_slots_touch before update on public.checkin_slots for each row execute function public.touch_updated_at();
create trigger notification_prefs_touch before update on public.notification_prefs for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------
-- 5. RLS · 권한
--    앱이 직접 바꿀 수 있는 것은 "시간·요일·켜기/끄기"뿐 (열 단위 권한).
--    구독 등록·발송 기록은 함수로만.
-- ---------------------------------------------------------------------
alter table public.checkin_slots      enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log   enable row level security;

revoke all on public.checkin_slots, public.notification_prefs, public.push_subscriptions, public.notification_log from anon, authenticated;

grant select on public.checkin_slots, public.notification_prefs, public.notification_log to authenticated;
grant select (id, device_label, created_at, last_success_at, disabled_at) on public.push_subscriptions to authenticated;  -- 키 값은 앱에 다시 내려주지 않음
grant update (local_time, weekdays, enabled) on public.checkin_slots to authenticated;
grant update (enabled) on public.notification_prefs to authenticated;

create policy checkin_slots_own_select on public.checkin_slots for select to authenticated using (user_id = (select auth.uid()));
create policy checkin_slots_own_update on public.checkin_slots for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notification_prefs_own_select on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));
create policy notification_prefs_own_update on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_subscriptions_own_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy notification_log_own_select on public.notification_log for select to authenticated using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 6. 앱용 함수 (로그인 사용자)
-- ---------------------------------------------------------------------

-- 첫 사용 시 기본 6개 슬롯 + 설정 생성 (이미 있으면 그대로)
create or replace function public.ensure_default_slots()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  insert into public.notification_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  if not exists (select 1 from public.checkin_slots where user_id = v_uid) then
    insert into public.checkin_slots (user_id, kind, local_time) values
      (v_uid, 'morning',       '09:00'),
      (v_uid, 'midday',        '12:00'),
      (v_uid, 'midday',        '15:00'),
      (v_uid, 'evening',       '18:00'),
      (v_uid, 'evening_final', '21:00'),
      (v_uid, 'review',        '23:00');
  end if;
end; $$;

-- 이 기기 구독 등록 (같은 endpoint면 갱신 · 다시 켬)
-- 구독 이전 정책: 다른 계정이 쓰던 endpoint(같은 기기)를 등록하면 이 계정으로 옮김 → 이전 계정은 그 기기로 알림을 받지 않음
--   개인용 MVP 정책. 자세한 내용: docs/notifications-impl.md 1-1
create or replace function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_label text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or char_length(p_endpoint) > 1000
     or coalesce(char_length(p_p256dh), 0) not between 40 and 200 or coalesce(char_length(p_auth), 0) not between 10 and 100 then
    raise exception '구독 정보가 올바르지 않습니다';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_label, 60))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
         failure_count = 0, disabled_at = null
  returning id into v_id;
  return v_id;
end; $$;

-- 구독 해제 (이 기기 또는 목록에서 다른 기기 삭제) — 본인 것만
create or replace function public.remove_push_subscription(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_subscriptions where id = p_id and user_id = (select auth.uid());
  return found;
end; $$;

-- 알림을 눌러 들어옴(opened) / 체크인을 끝까지 함(completed) — 본인 기록만, 처음 한 번만
create or replace function public.mark_checkin(p_log_id uuid, p_what text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_what = 'opened' then
    update public.notification_log set opened_at = now()
     where id = p_log_id and user_id = (select auth.uid()) and opened_at is null;
  elsif p_what = 'completed' then
    update public.notification_log set completed_at = now(), opened_at = coalesce(opened_at, now())
     where id = p_log_id and user_id = (select auth.uid()) and completed_at is null;
  else
    raise exception '알 수 없는 기록: %', p_what;
  end if;
  return found;
end; $$;


-- ---------------------------------------------------------------------
-- 7. 발송용 함수 (Cron · Edge Function 전용 = service_role)
-- ---------------------------------------------------------------------

-- 보낼 알림 선점 (매분). 순서: 만료 정리 → 실패 재시도 선점 → 새 슬롯 선점
--   반환: 이번에 선점한 log (Edge Function에 넘길 목록)
create or replace function public.claim_due_checkins(p_now timestamptz default now())
returns table (log_id uuid, user_id uuid, kind text, local_date date, attempts smallint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_window constant interval := interval '20 minutes';
  v_today  date := (p_now at time zone 'Asia/Seoul')::date;
begin
  -- 7-1. 만료 정리
  update public.notification_log l           -- 발송 시작 전에 멈춤 → 아무 기기에도 안 감 → 재시도 대상
     set status = 'failed', error = 'claim timeout', next_attempt_at = p_now
   where l.status = 'claimed' and l.claimed_at < p_now - interval '3 minutes';
  update public.notification_log l           -- 발송 중에 멈춤 → 일부 기기에 갔을 수 있음 → 재시도 안 함
     set status = 'unknown', error = coalesce(l.error, 'sending timeout')
   where l.status = 'sending' and l.sending_started_at < p_now - interval '5 minutes';
  update public.notification_log l           -- 시간 창 지남
     set status = 'expired'
   where l.status = 'failed' and p_now > l.due_at + v_window;

  -- 7-2. 실패 재시도 (최대 3번, 2분 간격, 시간 창 안)
  return query
  update public.notification_log l
     set status = 'claimed', claimed_at = p_now, attempts = l.attempts + 1, next_attempt_at = null
   where l.status = 'failed' and l.attempts < 3 and coalesce(l.next_attempt_at, p_now) <= p_now
     and p_now <= l.due_at + v_window
     and exists (select 1 from public.notification_prefs p where p.user_id = l.user_id and p.enabled)
     and exists (select 1 from public.checkin_slots s where s.id = l.slot_id and s.enabled)
  returning l.id, l.user_id, l.kind, l.local_date, l.attempts;

  -- 7-3. 새 슬롯 선점 (오늘 날짜 기준, 시간 창 안, 요일 맞음, 활성 구독 있음)
  return query
  insert into public.notification_log as l (user_id, slot_id, kind, local_date, due_at, status, claimed_at)
  select s.user_id, s.id, s.kind, v_today, (v_today + s.local_time) at time zone 'Asia/Seoul', 'claimed', p_now
    from public.checkin_slots s
    join public.notification_prefs p on p.user_id = s.user_id and p.enabled
   where s.enabled
     and extract(dow from v_today)::smallint = any (s.weekdays)
     and p_now >= (v_today + s.local_time) at time zone 'Asia/Seoul'
     and p_now <  (v_today + s.local_time) at time zone 'Asia/Seoul' + v_window
     and exists (select 1 from public.push_subscriptions ps where ps.user_id = s.user_id and ps.disabled_at is null)
  on conflict (slot_id, local_date) do nothing
  returning l.id, l.user_id, l.kind, l.local_date, l.attempts;
end; $$;

-- 발송 시작: claimed → sending 으로 바꾸는 데 성공한 것만 돌려줌 (Edge Function이 두 번 불려도 한쪽만 진행)
create or replace function public.begin_sending(p_log_ids uuid[])
returns table (log_id uuid, user_id uuid, kind text, local_date date)
language sql security definer set search_path = '' as $$
  update public.notification_log l
     set status = 'sending', sending_started_at = now()
   where l.id = any (p_log_ids) and l.status = 'claimed'
  returning l.id, l.user_id, l.kind, l.local_date;
$$;

-- 알림 문구용 개수 (해당 날짜 기준). 제목은 넣지 않음
create or replace function public.checkin_summary(p_user uuid, p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'overdue',  count(*) filter (where t.status <> 'done' and t.due_date < p_date),
    'remaining',count(*) filter (where t.status <> 'done' and ((t.status = 'active' and t.do_date <= p_date) or t.due_date <= p_date)),
    'done',     count(*) filter (where t.status = 'done' and (t.done_at at time zone 'Asia/Seoul')::date = p_date),
    'followup', count(*) filter (where t.status = 'waiting' and t.follow_up_date <= p_date)
  )
  from public.tasks t
  where t.user_id = p_user and t.deleted_at is null;
$$;

-- 기기 하나의 발송 결과: 성공 / 만료(404·410 → 비활성) / 기타 실패(5번 연속이면 비활성)
create or replace function public.record_push_result(p_subscription_id uuid, p_ok boolean, p_gone boolean default false)
returns void language sql security definer set search_path = '' as $$
  update public.push_subscriptions s
     set last_success_at = case when p_ok then now() else s.last_success_at end,
         failure_count   = case when p_ok then 0 else s.failure_count + 1 end,
         disabled_at     = case when p_ok then null
                                when p_gone or s.failure_count + 1 >= 5 then now()
                                else s.disabled_at end
   where s.id = p_subscription_id;
$$;

-- 발송 끝: 기기 결과를 모아 상태 결정. 전부 실패면 2분 뒤 재시도 대상
create or replace function public.finish_sending(p_log_id uuid, p_sent int, p_failed int, p_error text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  v_status := case when p_sent > 0 and p_failed = 0 then 'sent'
                   when p_sent > 0 then 'partial'
                   else 'failed' end;
  update public.notification_log
     set status = v_status,
         sent_at = case when p_sent > 0 then now() end,
         devices_sent = p_sent,
         error = left(p_error, 500),
         next_attempt_at = case when v_status = 'failed' then now() + interval '2 minutes' end
   where id = p_log_id and status = 'sending';
  return v_status;
end; $$;


-- ---------------------------------------------------------------------
-- 8. 함수 실행 권한
-- ---------------------------------------------------------------------
revoke execute on function
  public.touch_updated_at(), public.ensure_default_slots(),
  public.register_push_subscription(text, text, text, text), public.remove_push_subscription(uuid),
  public.mark_checkin(uuid, text), public.claim_due_checkins(timestamptz), public.begin_sending(uuid[]),
  public.checkin_summary(uuid, date), public.record_push_result(uuid, boolean, boolean),
  public.finish_sending(uuid, int, int, text)
from public, anon, authenticated;

grant execute on function public.ensure_default_slots()                                to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text)    to authenticated;
grant execute on function public.remove_push_subscription(uuid)                        to authenticated;
grant execute on function public.mark_checkin(uuid, text)                              to authenticated;

grant execute on function public.claim_due_checkins(timestamptz)                       to service_role;
grant execute on function public.begin_sending(uuid[])                                 to service_role;
grant execute on function public.checkin_summary(uuid, date)                           to service_role;
grant execute on function public.record_push_result(uuid, boolean, boolean)            to service_role;
grant execute on function public.finish_sending(uuid, int, int, text)                  to service_role;
grant select on public.push_subscriptions, public.checkin_slots, public.notification_log to service_role;
