-- =====================================================================
-- Steward 005 — 푸시 서명 키(VAPID) 보관
-- 키 쌍은 Edge Function(send-checkins)이 처음 필요할 때 직접 만들어 Vault에 저장
--   → 개인키가 사람·채팅·파일·환경 변수를 거치지 않음 (CRON 비밀값과 같은 원칙)
--   → 공개키만 앱에 내려줌 (send-checkins?vapid=public)
-- 한 번 저장되면 덮어쓰지 않음 (키가 바뀌면 기존 기기 구독이 모두 무효가 되므로)
-- 여러 번 실행해도 안전함
-- =====================================================================

-- 저장된 키 쌍 (service_role 전용)
create or replace function public.get_vapid_keys()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret::jsonb from vault.decrypted_secrets s where s.name = 'steward_vapid';
$$;

-- 처음 한 번만 저장. 이미 있으면(동시에 두 번 불려도) 기존 공개키를 돌려줌 (service_role 전용)
create or replace function public.store_vapid_keys(p_public text, p_private text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
begin
  select s.decrypted_secret::jsonb ->> 'publicKey' into v_existing from vault.decrypted_secrets s where s.name = 'steward_vapid';
  if v_existing is not null then
    return v_existing;
  end if;
  if p_public !~ '^[A-Za-z0-9_-]{80,100}$' or p_private !~ '^[A-Za-z0-9_-]{40,50}$' then
    raise exception 'VAPID 키 형식이 올바르지 않습니다';
  end if;
  perform vault.create_secret(jsonb_build_object('publicKey', p_public, 'privateKey', p_private)::text, 'steward_vapid',
                              'Steward: 푸시 서명 키 (send-checkins가 생성, 교체 시 모든 기기 구독 무효)');
  return p_public;
exception when unique_violation then
  return (select s.decrypted_secret::jsonb ->> 'publicKey' from vault.decrypted_secrets s where s.name = 'steward_vapid');
end;
$$;

revoke execute on function public.get_vapid_keys()               from public, anon, authenticated;
revoke execute on function public.store_vapid_keys(text, text)   from public, anon, authenticated;
grant  execute on function public.get_vapid_keys()               to service_role;
grant  execute on function public.store_vapid_keys(text, text)   to service_role;
