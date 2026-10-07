-- =====================================================================
-- Steward 002 — 하루 복기 (체크인 설계 v2 · 2-5, 2-6)
-- 23시 복기: 한 줄 기록 + 내일 가장 중요한 일. 하루 1행 (다시 저장하면 덮어씀)
-- 001_init.sql 실행 후에 실행
-- =====================================================================

create table public.daily_reviews (
  user_id      uuid        not null default auth.uid()
                           references auth.users (id) on delete cascade,
  review_date  date        not null,
  note         text        null,
  top_task_id  uuid        null references public.tasks (id) on delete set null,
  done_count   smallint    not null default 0,
  open_count   smallint    not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, review_date),
  constraint daily_reviews_note_len check (note is null or char_length(note) <= 300)
);

comment on table public.daily_reviews is '하루 복기. 내일 가장 중요한 일은 별표(starred)와 별개인 하루짜리 지정.';

alter table public.daily_reviews enable row level security;
revoke all on public.daily_reviews from anon;
revoke delete on public.daily_reviews from authenticated;

create policy daily_reviews_select_own on public.daily_reviews
  for select to authenticated using (user_id = (select auth.uid()));
create policy daily_reviews_insert_own on public.daily_reviews
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy daily_reviews_update_own on public.daily_reviews
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));


-- 복기 저장 (한 트랜잭션)
--   p_date        복기 대상 날짜 (자정 넘어 열어도 알림의 날짜 기준). 오늘 ~ 7일 전까지만
--   p_note        한 줄 복기 (선택, 300자)
--   p_top_task_id 내일 가장 중요한 일로 고른 기존 업무 (선택) → 할 날을 p_date+1로
--   p_new_title   새로 입력한 내일 가장 중요한 일 (선택, 있으면 이쪽이 우선) → 진행·할 날 p_date+1로 생성
--   security invoker: 호출한 사람 권한 + RLS 그대로
create or replace function public.save_daily_review(
  p_date        date,
  p_note        text default null,
  p_top_task_id uuid default null,
  p_new_title   text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_tomorrow date := p_date + 1;
  v_top      uuid := p_top_task_id;
  v_done     int;
  v_open     int;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다';
  end if;
  if p_date is null or p_date > public.app_today() or p_date < public.app_today() - 7 then
    raise exception '복기 날짜가 올바르지 않습니다';
  end if;

  if nullif(btrim(p_new_title), '') is not null then
    insert into public.tasks (title, status, do_date)
    values (btrim(p_new_title), 'active', v_tomorrow)
    returning id into v_top;
  elsif v_top is not null then
    -- 진행 상태로, 할 날은 내일로 (트리거가 대기 정보 정리 등을 처리)
    update public.tasks
       set status = 'active', do_date = v_tomorrow
     where id = v_top and deleted_at is null and status <> 'done';
    if not found then
      raise exception '선택한 업무를 찾을 수 없습니다';
    end if;
  end if;

  select count(*) into v_done
    from public.tasks
   where deleted_at is null and status = 'done'
     and (done_at at time zone 'Asia/Seoul')::date = p_date;

  select count(*) into v_open
    from public.tasks
   where deleted_at is null and status in ('inbox', 'active', 'waiting', 'later')
     and ((status = 'active' and do_date <= p_date) or due_date <= p_date);

  insert into public.daily_reviews (user_id, review_date, note, top_task_id, done_count, open_count)
  values (v_uid, p_date, nullif(btrim(p_note), ''), v_top, v_done, v_open)
  on conflict (user_id, review_date) do update
     set note = excluded.note,
         top_task_id = excluded.top_task_id,
         done_count = excluded.done_count,
         open_count = excluded.open_count,
         updated_at = now();

  return jsonb_build_object('review_date', p_date, 'top_task_id', v_top, 'done_count', v_done, 'open_count', v_open);
end;
$$;

revoke execute on function public.save_daily_review(date, text, uuid, text) from public, anon;
grant  execute on function public.save_daily_review(date, text, uuid, text) to authenticated;
