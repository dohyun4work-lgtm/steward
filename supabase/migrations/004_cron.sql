-- =====================================================================
-- Steward 004 — 매분 알림 선점 + Edge Function 호출  (설계안, 교차검토 전 · 실행 금지)
-- 실행 순서: 003 실행 → Edge Function(send-checkins) 배포 → 비밀값 2개 등록 → 이 파일 실행
-- 필요한 확장: pg_cron (예약), pg_net (DB에서 HTTP 호출), Vault (비밀값 보관) — Supabase 대시보드에서 켬
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 비밀값 등록 (값은 대시보드 SQL Editor에서 직접 입력, 이 파일에는 넣지 않음)
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-checkins', 'steward_send_url');
--   select vault.create_secret('<무작위 64자>', 'steward_cron_secret');   -- Edge Function 비밀값 CRON_SECRET과 같은 값

-- 매분: 선점은 DB 안에서 끝내고, 보낼 게 있을 때만 Edge Function 호출
create or replace function public.dispatch_checkins()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids    uuid[];
  v_url    text;
  v_secret text;
begin
  select array_agg(c.log_id) into v_ids from public.claim_due_checkins() c;
  if v_ids is null then
    return 0;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'steward_send_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'steward_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'steward: 비밀값(steward_send_url / steward_cron_secret)이 없어 발송하지 못함';
    return 0;   -- 선점된 기록은 3분 뒤 claim timeout → 재시도 규칙을 탐
  end if;
  -- 비동기 호출. 실패해도 선점 기록은 claimed로 남아 3분 뒤 재시도 대상이 됨
  perform net.http_post(
    url                  := v_url,
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-steward-cron', v_secret),
    body                 := jsonb_build_object('log_ids', v_ids),
    timeout_milliseconds := 30000
  );
  return cardinality(v_ids);
end;
$$;

revoke execute on function public.dispatch_checkins() from public, anon, authenticated;

-- 같은 이름의 예약이 있으면 갱신
select cron.schedule('steward-checkins', '* * * * *', $$select public.dispatch_checkins()$$);
