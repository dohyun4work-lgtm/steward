# Steward 5단계 — 실제 배포 순서

순서가 중요함. 앞 단계가 끝나야 다음 단계가 동작함.

| # | 할 일 | 어디서 | 확인 |
|---|---|---|---|
| 1 | `003_notifications.sql` 실행 | SQL Editor | "Success. No rows returned" |
| 2 | `005_vapid.sql` 실행 | SQL Editor | 같음 |
| 3 | Edge Function `send-checkins` 만들기 | Edge Functions → Deploy a new function → Via Editor | 이름 정확히 `send-checkins`, 코드 = `supabase/functions/send-checkins/index.ts` 전체 |
| 4 | 그 함수의 **Verify JWT 끄기** | send-checkins → Details(설정) | 꺼야 Cron이 호출 가능 (대신 x-steward-cron 비밀값으로 보호) |
| 5 | 공개키 생성 확인 | 브라우저에서 `https://mqmcpsuaurpajsfjryon.supabase.co/functions/v1/send-checkins?vapid=public` | `{"publicKey":"B…"}` (처음 열 때 키 쌍이 만들어져 Vault에 저장됨) |
| 6 | `004_cron.sql` 실행 | SQL Editor | pg_cron·pg_net 켜짐, 비밀값 자동 생성, 매분 예약 1개 |
| 7 | 앱 배포 (git push) | Claude | GitHub Pages 반영 1~5분 |
| 8 | 휴대폰에서 알림 켜기 | 홈 화면 Steward → 보관 → 알림 설정 → 이 기기에서 알림 켜기 | "이 기기에서 알림을 받고 있어요" |
| 9 | 실제 발송 확인 | 알림 시간 하나를 지금부터 5~10분 뒤로 바꿔 두기 | 그 시각에 알림 도착 → 누르면 해당 체크인 화면 |

## 비밀값 (사람이 다루지 않음)
- CRON 비밀값: 6번(004)이 DB 안에서 256비트 난수로 생성 → Vault에만 있음
- 푸시 서명 키(VAPID): 5번에서 Edge Function이 생성 → Vault에만 있음. 공개키만 앱에 전달
- Edge Function 환경 변수에 직접 넣을 값 없음 (SUPABASE_URL·SERVICE_ROLE_KEY는 Supabase가 자동으로 넣음)

## 문제가 생기면
- 예약 실행 기록: `select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;`
- 발송 기록: `select kind, local_date, status, attempts, devices_sent, error from notification_log order by claimed_at desc limit 10;`
- Edge Function 로그: Edge Functions → send-checkins → Logs (요약 한 줄만 남음, 비밀값·주소 없음)
- 알림 잠시 멈춤: `update cron.job set active = false where jobname = 'steward-checkins';`
