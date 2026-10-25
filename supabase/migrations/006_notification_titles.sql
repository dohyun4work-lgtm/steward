-- Steward 006 — 알림에 할 일 제목 보이기
-- 체크인 알림(아침·점심·저녁·마무리)에 남은 업무 제목을 최대 몇 개 함께 보낸다.
-- 순서는 TODAY 화면과 같음: 기한 지난 것 → 오늘 할 것, 그 안에서 별표 → 할 날짜 → 기한
-- 대상은 checkin_summary의 'remaining'과 같은 업무. 23시 복기 알림에는 쓰지 않음.
-- 기존 테이블·함수는 바꾸지 않음. 이 파일을 다시 실행해도 안전.

create or replace function public.checkin_titles(p_user uuid, p_date date, p_limit int default 3)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', x.title, 'overdue', x.overdue) order by x.ord), '[]'::jsonb)
  from (
    select left(t.title, 60) as title,
           coalesce(t.due_date < p_date, false) as overdue,
           row_number() over (order by
             case when t.due_date < p_date then 1 else 2 end,
             t.starred desc, t.do_date nulls last, t.due_date nulls last, t.created_at) as ord
      from public.tasks t
     where t.user_id = p_user
       and t.deleted_at is null
       and t.status <> 'done'
       and ((t.status = 'active' and t.do_date <= p_date) or t.due_date <= p_date)
  ) x
  where x.ord <= least(greatest(coalesce(p_limit, 3), 0), 5);
$$;

-- 발송 함수(Edge Function, service_role)만 실행. 앱·비로그인 불가
revoke all on function public.checkin_titles(uuid, date, int) from public, anon, authenticated;
grant execute on function public.checkin_titles(uuid, date, int) to service_role;
