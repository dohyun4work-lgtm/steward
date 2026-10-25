# Steward — 알림 제목(006) + 구글 캘린더 오늘 일정(007) 배포 순서

앱 화면은 GitHub에 올리면 바로 바뀌지만, 아래를 하기 전에는 캘린더 칸이 보이지 않고 알림도 예전 그대로라 순서가 어긋나도 문제는 없음.

| # | 할 일 | 어디서 | 확인 |
|---|---|---|---|
| 1 | `006_notification_titles.sql` 실행 | SQL Editor | "Success. No rows returned" |
| 2 | `007_calendar_feed.sql` 실행 | SQL Editor | 같음 |
| 3 | 새 Edge Function `calendar-today` 만들기 | Edge Functions → Deploy a new function → Via Editor | 이름 정확히 `calendar-today`, 코드 = `supabase/functions/calendar-today/index.ts` 전체. **Verify JWT는 켠 채로 둠**(기본값) |
| 4 | `send-checkins` 코드 바꾸기 | Edge Functions → send-checkins → Code | `supabase/functions/send-checkins/index.ts` 전체로 덮어쓰고 Deploy. **Verify JWT는 꺼진 채 유지** |
| 5 | 캘린더 연결 | Steward → 보관 → 알림 설정 → 맨 아래 「구글 캘린더」 | 비공개 주소 붙여 넣기 → 「연결했어요 · 오늘 일정 N개」 |
| 6 | 확인 | Steward 오늘 화면 / 다음 날 09시 알림 | 맨 위 「오늘 일정」, 알림 둘째 줄 「오늘 일정 N개 · …」 |

## 저장 위치와 공개 범위
- 비공개 주소: Supabase Vault 한 곳 (`steward_ical_<사용자 id>`). 앱 화면·GitHub·로그에 없음
- 일정 내용: 저장하지 않음. 볼 때마다 구글에서 읽어 화면과 알림에만 보여 줌
- 앱이 보는 것: 연결 여부, 마지막 확인 시각, 오류 종류
- 주소가 노출됐다면: 구글 캘린더 → 설정 및 공유 → 비공개 주소 「재설정」 → Steward에서 연결 해제 후 새 주소로 다시 연결

## 문제가 생기면
- 상태: `select connected_at, last_ok_at, last_error, last_error_at from calendar_feeds;`
- 함수 로그: Edge Functions → calendar-today → Logs (실패 종류만, 주소·일정 없음)
- 아침 알림에 일정 줄이 없으면: calendar-today가 배포됐는지, 설정 화면에 「연결되어 있어요」인지 확인. 그래도 없으면 calendar-today의 Verify JWT를 끄고 다시 확인 (함수 안에서 직접 토큰을 확인하므로 꺼도 안전)
