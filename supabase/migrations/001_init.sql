-- =====================================================================
-- DH Task Hub — Supabase 스키마 · 보안 설계안 v2 (최종 검토용, 아직 실행 금지)
-- v2: ① 반복 완료는 RPC만 ② 연동 키 폐기는 RPC만 ③ AI 함수는 Edge Function(service_role)만 호출 ④ 반복 재설정 시 새 시리즈
-- 대상: Supabase (PostgreSQL 15+), Supabase Auth 사용
-- 순서대로 한 번에 실행하는 마이그레이션 파일 형태
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 기본 함수: 한국 시간 기준 "오늘"
--    Supabase 서버 시간은 UTC라서 current_date를 쓰면 오전 9시 전까지
--    날짜가 하루 밀린다. 날짜 계산은 전부 이 함수를 거친다.
-- ---------------------------------------------------------------------
create or replace function public.app_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;


-- ---------------------------------------------------------------------
-- 1. tasks 테이블
-- ---------------------------------------------------------------------
create table public.tasks (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null default auth.uid()
                                 references auth.users (id) on delete cascade,

  title              text        not null,
  status             text        not null default 'inbox',
  area               text        null,
  do_date            date        null,
  due_date           date        null,
  starred            boolean     not null default false,
  next_action        text        null,
  memo               text        not null default '',

  waiting_for        text        null,
  follow_up_date     date        null,

  -- 반복: 규칙과 기준일, 시리즈 묶음
  repeat_rule        text        null,      -- 'weekly' | 'monthly'
  repeat_anchor_day  smallint    null,      -- 매월 반복의 기준일 (31이면 "매월 말일까지 31일")
  series_id          uuid        null,      -- 같은 반복에서 생긴 업무끼리 공유
  occurrence_date    date        null,      -- 이 업무가 반복 일정상 몇 번째 날짜인지 (미뤄도 그대로)

  source             text        not null default 'manual',
  calendar_event_id  text        null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  done_at            timestamptz null,
  deleted_at         timestamptz null,

  -- 값 범위
  constraint tasks_title_len      check (char_length(title) between 1 and 500),
  constraint tasks_memo_len       check (char_length(memo) <= 10000),
  constraint tasks_status_chk     check (status in ('inbox','active','waiting','later','done')),
  constraint tasks_area_chk       check (area is null or area in ('TLC','LEVITES','MEDIA','ADMIN','PERSONAL')),
  constraint tasks_source_chk     check (source in ('manual','ai','calendar','repeat')),
  constraint tasks_repeat_chk     check (repeat_rule is null or repeat_rule in ('weekly','monthly')),
  constraint tasks_anchor_chk     check (repeat_anchor_day is null or repeat_anchor_day between 1 and 31),

  -- 상태 불변 조건 (트리거가 먼저 정리하고, 이 제약이 최종 방어선)
  constraint tasks_active_needs_do_date
    check (status <> 'active' or do_date is not null),
  constraint tasks_waiting_fields
    check (
      (status =  'waiting' and waiting_for is not null and follow_up_date is not null)
      or
      (status <> 'waiting' and waiting_for is null and follow_up_date is null)
    ),
  constraint tasks_done_at_matches_status
    check ((status = 'done') = (done_at is not null)),
  constraint tasks_repeat_needs_series
    check (repeat_rule is null or (series_id is not null and occurrence_date is not null))
);

comment on table public.tasks is 'DH Task Hub 업무. 삭제는 deleted_at으로만(soft delete).';


-- ---------------------------------------------------------------------
-- 2. 인덱스
--    개인용이라 데이터가 수천 건 수준이면 인덱스 없이도 충분히 빠르다.
--    아래는 화면별 조회 조건에 맞춘 최소 구성 + 반복 중복 방지용 UNIQUE.
-- ---------------------------------------------------------------------

-- TODAY / THIS WEEK: 진행 중 업무를 할 날로 조회
create index tasks_active_do_date_idx
  on public.tasks (user_id, do_date)
  where status = 'active' and deleted_at is null;

-- 기한 초과 / 오늘 마감: 열린 업무의 마감일
create index tasks_open_due_date_idx
  on public.tasks (user_id, due_date)
  where status <> 'done' and due_date is not null and deleted_at is null;

-- 확인 필요 / 대기 화면
create index tasks_waiting_idx
  on public.tasks (user_id, follow_up_date)
  where status = 'waiting' and deleted_at is null;

-- 인박스 / 나중에 화면
create index tasks_status_idx
  on public.tasks (user_id, status, created_at)
  where deleted_at is null;

-- 완료 화면 (최근 완료순)
create index tasks_done_idx
  on public.tasks (user_id, done_at desc)
  where status = 'done' and deleted_at is null;

-- 반복 업무 중복 생성 방지: 같은 시리즈의 같은 회차는 하나만
create unique index tasks_series_occurrence_uniq
  on public.tasks (series_id, occurrence_date)
  where series_id is not null and deleted_at is null;


-- ---------------------------------------------------------------------
-- 3. 최근 대기 대상 (대기 해제 시 waiting_for를 비우므로 이름 칩은 별도 보관)
-- ---------------------------------------------------------------------
create table public.recent_waiting (
  user_id       uuid        not null default auth.uid()
                            references auth.users (id) on delete cascade,
  name          text        not null check (char_length(name) between 1 and 100),
  last_used_at  timestamptz not null default now(),
  primary key (user_id, name)
);


-- ---------------------------------------------------------------------
-- 4. 정규화 트리거 (BEFORE INSERT/UPDATE)
--    상태 전환 규칙을 DB에서도 강제한다. 앱이 실수하거나 AI·외부에서
--    직접 넣어도 데이터가 어긋나지 않게 하는 것이 목적.
-- ---------------------------------------------------------------------
create or replace function public.tasks_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- 생성 시각은 서버가 정한다 (클라이언트 값 무시)
    new.created_at := now();
    new.updated_at := now();
  else
    -- 불변 컬럼: 바꾸려 하면 오류
    if new.created_at is distinct from old.created_at then
      raise exception 'created_at은 수정할 수 없습니다';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'user_id는 수정할 수 없습니다';
    end if;
    if new.source is distinct from old.source then
      raise exception 'source는 수정할 수 없습니다';
    end if;
    -- 반복 시리즈 컬럼은 트리거만 관리 (앱이 직접 바꾸면 오류)
    if new.series_id is distinct from old.series_id
       or new.occurrence_date is distinct from old.occurrence_date then
      raise exception 'series_id, occurrence_date는 직접 수정할 수 없습니다';
    end if;
    new.updated_at := now();
  end if;

  -- ① 반복 업무의 완료/완료 취소는 complete_task / uncomplete_task RPC로만
  --    (일반 UPDATE로 done 처리하면 다음 회차가 안 생기므로 막는다)
  --    RPC는 같은 트랜잭션 안에서 app.rpc_task_id에 대상 id를 표시한 뒤 수정한다.
  if (tg_op = 'INSERT' and new.status = 'done' and new.repeat_rule is not null)
     or (tg_op = 'UPDATE'
         and coalesce(old.repeat_rule, new.repeat_rule) is not null
         and (old.status = 'done') <> (new.status = 'done')
         and current_setting('app.rpc_task_id', true) is distinct from new.id::text) then
    raise exception '반복 업무의 완료·완료 취소는 complete_task / uncomplete_task로만 할 수 있습니다';
  end if;

  new.title := btrim(new.title);

  -- 진행(active): 할 날이 없으면 오늘
  --   (다른 상태에서 '진행'으로 올 때 오늘로 바꾸는 UX 규칙은 앱이 do_date를 명시해서 보냄.
  --    DB는 "할 날 없는 진행 업무"만 막는다.)
  if new.status = 'active' and new.do_date is null then
    new.do_date := public.app_today();
  end if;

  -- 대기(waiting): 확인일 기본 3일 후 / 대기 아니면 대기 정보 정리
  if new.status = 'waiting' then
    if new.follow_up_date is null then
      new.follow_up_date := public.app_today() + 3;
    end if;
    new.waiting_for := nullif(btrim(new.waiting_for), '');
  else
    new.waiting_for := null;
    new.follow_up_date := null;
  end if;

  -- 완료 시각
  if new.status = 'done' then
    if new.done_at is null then new.done_at := now(); end if;
  else
    new.done_at := null;
  end if;

  -- ④ 반복 시리즈 규칙
  --   - 반복을 새로 켜거나(없음 → 매주/매월) 규칙을 바꾸면(매주 ↔ 매월) 새 시리즈로 시작
  --     : 새 series_id, 회차 = 현재 할 날(없으면 오늘), 매월 기준일 = 그 날짜의 일
  --   - 반복을 끄면 series_id·occurrence_date는 기록으로 남기고 기준일만 비움
  --     (다시 켜면 위 규칙대로 새 시리즈. 예전 시리즈를 이어가지 않음)
  --   - complete_task가 만든 다음 회차(INSERT에 series_id가 이미 있음)는 그대로 유지
  if new.repeat_rule is not null then
    if new.series_id is null
       or (tg_op = 'UPDATE' and new.repeat_rule is distinct from old.repeat_rule) then
      new.series_id         := gen_random_uuid();
      new.occurrence_date   := coalesce(new.do_date, public.app_today());
      new.repeat_anchor_day := null;
    end if;
    if new.occurrence_date is null then
      new.occurrence_date := coalesce(new.do_date, public.app_today());
    end if;
    if new.repeat_rule = 'monthly' and new.repeat_anchor_day is null then
      new.repeat_anchor_day := extract(day from new.occurrence_date)::smallint;
    end if;
  else
    new.repeat_anchor_day := null;
  end if;

  return new;
end;
$$;

create trigger tasks_normalize_trg
  before insert or update on public.tasks
  for each row execute function public.tasks_normalize();


-- 대기로 넘길 때 최근 대상 목록 갱신 (AFTER)
create or replace function public.tasks_remember_waiting()
returns trigger
language plpgsql
security definer          -- recent_waiting에 쓰기 위해. 대상 user_id는 행에서 가져옴
set search_path = ''
as $$
begin
  if new.status = 'waiting' and new.waiting_for is not null
     and (tg_op = 'INSERT' or old.waiting_for is distinct from new.waiting_for or old.status <> 'waiting') then
    insert into public.recent_waiting (user_id, name, last_used_at)
    values (new.user_id, new.waiting_for, now())
    on conflict (user_id, name) do update set last_used_at = excluded.last_used_at;
  end if;
  return null;
end;
$$;

create trigger tasks_remember_waiting_trg
  after insert or update of status, waiting_for on public.tasks
  for each row execute function public.tasks_remember_waiting();


-- ---------------------------------------------------------------------
-- 5. RLS (행 수준 보안)
--    원칙: 로그인한 본인 행만. anon(비로그인)은 테이블 직접 접근 불가.
--    실제 삭제(DELETE) 권한은 아무에게도 주지 않음 → soft delete만 가능.
-- ---------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.recent_waiting enable row level security;

revoke all on public.tasks          from anon;
revoke all on public.recent_waiting from anon;
revoke delete on public.tasks       from authenticated;

-- tasks: 조회 (삭제된 행도 포함 → 되돌리기 복원용. 앱 목록에서는 deleted_at is null로 거름)
create policy tasks_select_own on public.tasks
  for select to authenticated
  using (user_id = (select auth.uid()));

-- tasks: 추가 (본인 소유만, 'ai' 출처는 앱에서 직접 못 넣음 → AI 전용 함수로만)
create policy tasks_insert_own on public.tasks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and source in ('manual', 'calendar', 'repeat')
  );

-- tasks: 수정 (본인 행만, 소유자 변경 불가)
create policy tasks_update_own on public.tasks
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- DELETE 정책 없음 = 실제 삭제 불가

-- recent_waiting: 본인 것 조회·정리만 (추가는 트리거가 함)
create policy recent_waiting_select_own on public.recent_waiting
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy recent_waiting_delete_own on public.recent_waiting
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 6. 반복 업무 다음 날짜 계산
--    매월 반복은 기준일(anchor)을 유지: 31일 → 2/28 → 3/31
-- ---------------------------------------------------------------------
create or replace function public.next_occurrence(
  p_rule   text,
  p_anchor smallint,
  p_from   date,
  p_today  date
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  d date := p_from;
  m date;
begin
  loop
    if p_rule = 'weekly' then
      d := d + 7;
    elsif p_rule = 'monthly' then
      m := (date_trunc('month', d) + interval '1 month')::date;
      d := least(
             m + (coalesce(p_anchor, extract(day from p_from)::smallint) - 1),
             (m + interval '1 month' - interval '1 day')::date
           );
    else
      raise exception '알 수 없는 반복 규칙: %', p_rule;
    end if;
    exit when d > p_today;
  end loop;
  return d;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. 완료 처리 RPC (한 트랜잭션)
--    - 이미 완료된 업무면 아무것도 안 함 (중복 완료 방지)
--    - 반복이면 다음 회차를 만들되, 이미 있으면 만들지 않음 (UNIQUE + ON CONFLICT)
--    - security invoker: 호출한 사람 권한 + RLS 그대로 적용
-- ---------------------------------------------------------------------
create or replace function public.complete_task(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t        public.tasks;
  v_next   date;
  v_new_id uuid;
begin
  perform set_config('app.rpc_task_id', p_id::text, true);   -- 이 트랜잭션에서만 유효

  update public.tasks
     set status = 'done'
   where id = p_id
     and status <> 'done'
     and deleted_at is null
  returning * into t;

  perform set_config('app.rpc_task_id', '', true);

  if not found then
    return jsonb_build_object('completed', false);
  end if;

  if t.repeat_rule is not null then
    v_next := public.next_occurrence(t.repeat_rule, t.repeat_anchor_day, t.occurrence_date, public.app_today());

    insert into public.tasks (
      user_id, title, status, area, do_date, due_date, starred, memo,
      repeat_rule, repeat_anchor_day, series_id, occurrence_date, source
    ) values (
      t.user_id, t.title, 'active', t.area, v_next,
      case when t.due_date is not null then v_next + (t.due_date - t.occurrence_date) end,
      t.starred, t.memo,
      t.repeat_rule, t.repeat_anchor_day, t.series_id, v_next, 'repeat'
    )
    on conflict (series_id, occurrence_date)
      where series_id is not null and deleted_at is null
    do nothing
    returning id into v_new_id;
  end if;

  return jsonb_build_object(
    'completed', true,
    'next_id',   v_new_id,
    'next_date', v_next
  );
end;
$$;


-- 완료 되돌리기 RPC
--   - 진행 상태로 복원
--   - 이 완료로 자동 생성된 다음 회차가 아직 손대지 않은 상태면 soft delete
create or replace function public.uncomplete_task(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t         public.tasks;
  v_done_at timestamptz;
begin
  select * into t
    from public.tasks
   where id = p_id and status = 'done' and deleted_at is null
   for update;

  if not found then
    return jsonb_build_object('restored', false);
  end if;

  v_done_at := t.done_at;

  perform set_config('app.rpc_task_id', p_id::text, true);
  update public.tasks
     set status = 'active'
   where id = p_id;
  perform set_config('app.rpc_task_id', '', true);

  if t.series_id is not null then
    update public.tasks
       set deleted_at = now()
     where series_id = t.series_id
       and source = 'repeat'
       and occurrence_date > t.occurrence_date
       and status = 'active'
       and deleted_at is null
       and created_at >= v_done_at
       and updated_at = created_at;      -- 생성 후 수정하지 않은 것만
  end if;

  return jsonb_build_object('restored', true);
end;
$$;


-- ---------------------------------------------------------------------
-- 8. "오늘" 조회 함수 (앱과 AI가 같은 규칙을 쓰도록 한 곳에 정의)
--    bucket: overdue | today | follow_up
--    규칙은 프로토타입 v2 구조 설명서 3번과 동일
-- ---------------------------------------------------------------------
create or replace function public.today_items(p_user uuid)
returns table (
  id uuid, bucket text, title text, status text, area text,
  do_date date, due_date date, starred boolean,
  next_action text, waiting_for text, follow_up_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select t.*, public.app_today() as today
      from public.tasks t
     where t.user_id = p_user
       and t.deleted_at is null
       and t.status <> 'done'
  )
  select id,
         case
           when due_date < today then 'overdue'
           when due_date = today
             or (status = 'active' and do_date <= today) then 'today'
           when status = 'waiting' and follow_up_date <= today then 'follow_up'
         end as bucket,
         title, status, area, do_date, due_date, starred,
         next_action, waiting_for, follow_up_date
    from base
   where due_date <= today
      or (status = 'active' and do_date <= today)
      or (status = 'waiting' and follow_up_date <= today)
   order by
     case
       when due_date < today then 1
       when due_date = today or (status = 'active' and do_date <= today) then 2
       else 3
     end,
     starred desc, do_date nulls last, due_date nulls last
$$;

-- 앱용: 로그인한 본인의 오늘
create or replace function public.get_today()
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select to_jsonb(x) from public.today_items((select auth.uid())) x
$$;


-- ---------------------------------------------------------------------
-- 9. AI 연동용 권한 구조
--    ③ 최종 구조: AI → Edge Function → DB
--    - 앱은 지금처럼 Supabase에 직접 연결 (로그인 + RLS)
--    - AI는 Edge Function 주소만 알고, 연동 키를 Authorization 헤더로 보냄
--    - Edge Function이 service_role로 아래 ai_* 함수를 호출 (service_role 키는 Edge Function 비밀값에만)
--    - ai_* 함수는 service_role만 실행 가능 → DB REST 주소로 직접 호출 불가
--    - MVP에서는 Edge Function을 만들지 않음. 함수만 준비해 두고 아무도 못 부르는 상태로 둠
--    원칙
--    - AI(ChatGPT 등)에게는 로그인 세션도, service_role 키도 주지 않는다.
--    - 기능별 "연동 키"를 발급해 두 가지만 허용: 오늘 읽기, 인박스에 추가.
--    - 키는 해시만 저장(원문은 발급 때 한 번만 보여줌), 언제든 폐기 가능.
--    - AI는 상태 변경·삭제·완료 처리 불가. 넣은 업무는 source='ai', status='inbox'로 고정.
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create table public.integration_keys (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid()
                            references auth.users (id) on delete cascade,
  name          text        not null check (char_length(name) between 1 and 50),  -- 예: 'ChatGPT'
  key_hash      bytea       not null unique,
  scopes        text[]      not null
                            check (scopes <@ array['today:read','inbox:add']::text[] and cardinality(scopes) > 0),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz null,
  revoked_at    timestamptz null
);

alter table public.integration_keys enable row level security;
revoke all on public.integration_keys from anon;
-- ② 앱 사용자는 조회만. 발급·폐기는 아래 RPC로만 (컬럼 임의 수정 불가)
revoke insert, update, delete on public.integration_keys from authenticated;

create policy integration_keys_select_own on public.integration_keys
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 키 폐기: 본인 키만, 이미 폐기된 키는 그대로
create or replace function public.revoke_integration_key(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception '로그인이 필요합니다';
  end if;
  update public.integration_keys
     set revoked_at = now()
   where id = p_id
     and user_id = v_user
     and revoked_at is null;
  return found;
end;
$$;

-- 키 발급 (로그인한 본인만). 원문 키는 이 응답에서 한 번만 볼 수 있음.
--   security definer: integration_keys에 직접 insert 권한을 주지 않기 위해.
--   소유자는 항상 auth.uid()로 고정되므로 남의 키를 만들 수 없음.
create or replace function public.create_integration_key(p_name text, p_scopes text[])
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_key  text := 'dhth_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  if v_user is null then
    raise exception '로그인이 필요합니다';
  end if;
  insert into public.integration_keys (user_id, name, scopes, key_hash)
  values (v_user, p_name, p_scopes, extensions.digest(v_key, 'sha256'));
  return v_key;
end;
$$;

-- 내부용 키 확인 (scope 검사 + 사용 시각 기록)
create or replace function public._resolve_key(p_key text, p_scope text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  update public.integration_keys
     set last_used_at = now()
   where key_hash = extensions.digest(p_key, 'sha256')
     and revoked_at is null
     and p_scope = any (scopes)
  returning user_id into v_user;

  if v_user is null then
    raise exception '유효하지 않은 연동 키입니다' using errcode = '28000';
  end if;
  return v_user;
end;
$$;

-- AI: 오늘 할 일 읽기
create or replace function public.ai_get_today(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._resolve_key(p_key, 'today:read');
begin
  return jsonb_build_object(
    'date',  public.app_today(),
    'items', coalesce((select jsonb_agg(to_jsonb(x)) from public.today_items(v_user) x), '[]'::jsonb)
  );
end;
$$;

-- AI: 인박스에 추가 (제목·메모만, 시간당 30건 제한)
create or replace function public.ai_add_inbox(p_key text, p_title text, p_memo text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._resolve_key(p_key, 'inbox:add');
  v_id   uuid;
begin
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    raise exception '제목은 1~200자여야 합니다';
  end if;
  if p_memo is not null and char_length(p_memo) > 2000 then
    raise exception '메모는 2000자 이하여야 합니다';
  end if;
  if (select count(*) from public.tasks
       where user_id = v_user and source = 'ai'
         and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'AI 추가 한도(시간당 30건)를 넘었습니다';
  end if;

  insert into public.tasks (user_id, title, memo, status, source)
  values (v_user, p_title, coalesce(p_memo, ''), 'inbox', 'ai')
  returning id into v_id;

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 10. 함수 실행 권한 정리
--     Supabase는 public 스키마 함수를 기본으로 anon·authenticated에게 열어 두므로
--     하나씩 명시적으로 닫고 연다.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- 로그인한 앱 사용자
grant execute on function public.app_today()                           to authenticated;
grant execute on function public.complete_task(uuid)                   to authenticated;
grant execute on function public.uncomplete_task(uuid)                 to authenticated;
grant execute on function public.get_today()                           to authenticated;
grant execute on function public.today_items(uuid)                     to authenticated;   -- RLS로 본인 것만 보임
grant execute on function public.next_occurrence(text, smallint, date, date) to authenticated;
grant execute on function public.create_integration_key(text, text[])  to authenticated;
grant execute on function public.revoke_integration_key(uuid)          to authenticated;

-- AI 연동: Edge Function(service_role)만 호출 가능. anon·authenticated는 직접 호출 불가
revoke execute on function public.ai_get_today(text)             from public, anon, authenticated;
revoke execute on function public.ai_add_inbox(text, text, text) from public, anon, authenticated;
grant  execute on function public.ai_get_today(text)             to service_role;
grant  execute on function public.ai_add_inbox(text, text, text) to service_role;

-- 내부 함수(_로 시작)와 트리거 함수는 누구에게도 직접 실행 권한 없음

-- 이후 새로 만드는 함수도 기본으로 닫아 두기
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
