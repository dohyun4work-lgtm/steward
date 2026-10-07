-- =====================================================================
-- Steward 004 — 매분 알림 선점 + Edge Function 호출
-- 실행 순서: 003 실행 → Edge Function(send-checkins) 배포 → 이 파일 실행
-- 필요한 확장: pg_cron (예약), pg_net (DB에서 HTTP 호출), Vault (비밀값 보관)
--
-- 여러 번 실행해도 안전함 (로컬 pg_cron 1.6에서 확인)
--   - 확장: if not exists
--   - 비밀값: 없을 때만 생성 (다시 실행해도 기존 값 유지)
--   - 함수: create or replace
--   - 예약: cron.schedule은 같은 이름이 있으면 그 job을 갱신 (같은 jobid, 중복 생성 없음)
--     ※ cron.unschedule은 없는 이름이면 오류를 내므로 이 파일에서는 쓰지 않음
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- 1. 비밀값 (Vault)
--    steward_cron_secret: Cron → Edge Function 호출 헤더 x-steward-cron 값
--      DB 안에서 32바이트(256비트) 난수로 생성. 사람·채팅·파일을 거치지 않음
--      Edge Function은 이 값을 따로 갖지 않고, 받은 헤더를 verify_cron_secret()으로 DB에 확인
--      → 값의 원본은 Vault 한 곳뿐, 교체도 한 줄 (아래 4번)
--    steward_send_url: Edge Function 주소 (비밀은 아니지만 같은 곳에 둠)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'steward_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'steward_cron_secret',
                                'Steward: Cron이 send-checkins를 부를 때 쓰는 헤더 값');
  end if;
  if not exists (select 1 from vault.secrets where name = 'steward_send_url') then
    perform vault.create_secret('https://mqmcpsuaurpajsfjryon.supabase.co/functions/v1/send-checkins', 'steward_send_url',
                                'Steward: send-checkins Edge Function 주소');
  end if;
end $$;

-- Edge Function이 받은 헤더가 맞는지 확인 (service_role 전용)
--   해시끼리 비교 → 비교 시간으로 값이 새어 나가지 않음. 값 자체는 어디에도 반환·기록하지 않음
create or replace function public.verify_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select extensions.digest(coalesce(p_secret, ''), 'sha256') = extensions.digest(s.decrypted_secret, 'sha256')
       from vault.decrypted_secrets s where s.name = 'steward_cron_secret'),
    false)
  and char_length(coalesce(p_secret, '')) = 64;
$$;

-- ---------------------------------------------------------------------
-- 2. 매분 실행: 선점은 DB 안에서 끝내고, 보낼 게 있을 때만 Edge Function 호출
--    호출이 실패해도 선점 기록은 claimed로 남아 3분 뒤 claim timeout → 재시도 (003 7-1)
--    비밀값은 오류·경고 메시지에 넣지 않음
-- ---------------------------------------------------------------------
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
    raise warning 'steward: Vault 비밀값이 없어 발송하지 못함 (선점 % 건은 3분 뒤 재시도 대상)', cardinality(v_ids);
    return 0;
  end if;
  perform net.http_post(
    url                  := v_url,
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-steward-cron', v_secret),
    body                 := jsonb_build_object('log_ids', v_ids),
    timeout_milliseconds := 30000
  );
  return cardinality(v_ids);
end;
$$;

revoke execute on function public.verify_cron_secret(text) from public, anon, authenticated;
revoke execute on function public.dispatch_checkins()      from public, anon, authenticated;
grant  execute on function public.verify_cron_secret(text) to service_role;

-- ---------------------------------------------------------------------
-- 3. 예약 (같은 이름이면 갱신)
-- ---------------------------------------------------------------------
select cron.schedule('steward-checkins', '* * * * *', $$select public.dispatch_checkins()$$);

-- ---------------------------------------------------------------------
-- 4. 운영 메모 (실행하지 않음)
--   비밀값 교체 (Edge Function 재배포 불필요, 즉시 적용. 교체 순간 진행 중이던 호출은 실패 → 3분 뒤 재시도)
--     select vault.update_secret((select id from vault.secrets where name = 'steward_cron_secret'),
--                                encode(extensions.gen_random_bytes(32), 'hex'));
--   알림 발송 잠시 멈춤 / 다시 시작
--     update cron.job set active = false where jobname = 'steward-checkins';
--     update cron.job set active = true  where jobname = 'steward-checkins';
--   예약 상태 확인
--     select jobid, schedule, command, active from cron.job where jobname = 'steward-checkins';
--     select status, return_message, start_time from cron.job_run_details
--      where jobid = (select jobid from cron.job where jobname = 'steward-checkins') order by start_time desc limit 10;
--   참고: pg_net은 요청을 보내기 전까지 net.http_request_queue에 헤더를 잠시 보관함 (그 테이블 접근 권한은 Supabase 기본 설정을 따름)
-- =====================================================================
