# Steward 8단계 — Google Calendar 연동 설계안

## 0. 결정 (2026-10-25): A안 먼저 — iCal 비공개 주소로 읽기만
DH: "복잡하니까 A만 우선". 아래 1~7번(OAuth·쓰기, B안)은 보류. 나중에 B안을 할 때 이 문서에서 다시 시작.

| 항목 | A안 구현 |
|---|---|
| 연결 | 설정 화면에 구글 캘린더 「iCal 형식의 비공개 주소」를 붙여 넣음. 구글 개발자 설정·로그인 없음 |
| 주소 보관 | Vault `steward_ical_<user>` 한 곳. 앱에 다시 내려주지 않음, 로그에 남기지 않음 (007) |
| 앱이 보는 것 | `calendar_feeds`: 연결 시각·마지막 확인·오류 종류만 |
| 일정 읽기 | Edge Function `calendar-today`가 볼 때마다 주소에서 받아 그날 일정만 돌려줌. **DB 저장 없음**. 함수 안 3분 캐시 |
| 반복 일정 | ical.js로 펼침 (매주·매년·예외로 바꾼 날·뺀 날·종일·여러 날·다른 시간대). 서울 시각 기준 |
| 화면 | TODAY 「오늘」 보기 맨 위 「오늘 일정」(종일 → 시간순, 지난 일정은 흐리게). 앱은 5분마다만 다시 받음 |
| 아침 알림 | 09시 알림 둘째 줄 「오늘 일정 4개 · 10:00 교역자 회의」(지금 이후 첫 일정, 없으면 종일). 실패하면 줄 없이 발송 |
| 호출 권한 | 앱: 로그인 토큰 → Auth로 확인한 본인만. send-checkins: service_role 키 + user_id |
| 반영 속도 | 구글 쪽 iCal 갱신이 몇 분 늦을 수 있음 |
| 노출 | 일정 제목이 TODAY 화면과 아침 알림(잠금 화면)에 보임 |

배포 순서: `docs/deploy-calendar.md`. 테스트: `test/sql-calendar.js`(22), `test/deno-calendar.ts`(13), `test/deno-morning.ts`(8), `test/e2e-calendar.js`(29).

---

# (보류) B안 설계 v1 — Google 로그인 + 업무 → 캘린더 쓰기

목표: **Steward 업무를 개인 Google Calendar에 자동으로 올리기**(쓰기)까지. 그 과정에서 오늘 캘린더 일정을 Steward에서 보는 것(읽기)도 함께 한다.
대상: DH 개인 Google 계정 하나. 교회 공용 캘린더는 범위 밖.

`tasks`에는 이미 `source`('calendar' 허용)와 `calendar_event_id` 칸이 있다(001, "연동 대비"). 기존 화면 구조·상태 규칙은 바꾸지 않는다.

---

## 1. 연결 방식: Google 로그인(OAuth) — 서버가 열쇠를 보관

| 항목 | 방식 |
|---|---|
| Google 쪽 | DH 개인 Google Cloud 프로젝트 1개, Calendar API 켜기, 웹 OAuth 클라이언트 1개 |
| 권한 범위 | `calendar.app.created` (Steward가 만든 캘린더에만 쓰기) + `calendar.events.owned.readonly` (내 캘린더 일정 읽기만). **기존 일정을 고치거나 지울 수 있는 권한은 받지 않음** |
| 앱 게시 상태 | 「테스트」 상태에서는 갱신 토큰이 **7일마다 만료**됨 → 설정 확인 후 「프로덕션」으로 게시. 사용자 1명이라 Google 심사 없이 "확인되지 않은 앱" 안내만 한 번 넘기면 됨 (검토 필요) |
| 연결 흐름 | 알림 설정 화면 → 「구글 캘린더 연결」 → Google 동의 화면 → Edge Function `calendar-auth`가 코드를 받아 토큰 교환 → 앱 `#/settings`로 복귀 |
| 위조 방지 | 연결 시작 시 서버가 한 번만 쓰는 `state` 값(사용자·만료 10분)을 만들고, 돌아올 때 확인 |
| 갱신 토큰 보관 | **Vault에만** (`steward_gcal_<user>`). 앱·GitHub·AI·로그에 없음. 앱은 "연결됨 / 이메일 / 마지막 동기화"만 봄 |
| 클라이언트 비밀값 | DH가 Supabase Edge Function 비밀값에 한 번 입력 (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). 사람이 다루는 유일한 비밀값 |
| 연결 끊기 | 설정 화면 「연결 해제」 → Google에 토큰 철회 + Vault 삭제. Steward 캘린더 자체는 남겨 둘지 선택 |

## 2. 쓰기: Steward 업무 → 「Steward」 캘린더 (한 방향)

- 연결할 때 Google에 **「Steward」라는 보조 캘린더를 새로 만든다**. 개인 기본 캘린더와 섞이지 않고, Google 캘린더에서 체크 하나로 숨기거나 색을 바꿀 수 있다.
- 업무에는 시간이 없으므로 **하루 종일 일정**으로 올린다.
- 올릴 업무·날짜, 완료 처리 방식은 DH 결정 필요 (아래 6번).
- 한 방향: Steward가 기준. Google 캘린더에서 「Steward」 일정을 고쳐도 Steward로 가져오지 않고, 다음 동기화 때 Steward 내용으로 되돌린다.

**동기화 구조** (기존 알림과 같은 방식)
```
tasks 변경 (앱)  →  트리거가 calendar_sync_queue에 "이 업무 다시 맞추기" 기록 (같은 업무는 1줄로 합침)
pg_cron 매분     →  할 일이 있을 때만 Edge Function sync-calendar 호출 (x-steward-cron 비밀값)
sync-calendar    →  Vault 토큰으로 Google API: 만들기 / 고치기 / 지우기 → tasks.calendar_event_id 저장
```
- 실패하면 2분·10분·1시간 뒤 재시도, 5번 실패하면 멈추고 설정 화면에 "동기화 문제" 표시
- 토큰이 철회·만료되면 연결 상태를 "다시 연결 필요"로 바꾸고 더 시도하지 않음
- 연결 직후 한 번: 조건에 맞는 기존 업무 전체를 올림
- 업무 제목·메모 중 **제목만** 보냄. 메모는 캘린더에 올리지 않음

## 3. 읽기: 오늘 일정 보기

- TODAY 화면 위쪽에 오늘 일정(시간·제목) 목록. 「Steward」 캘린더 일정은 빼고 개인 캘린더 일정만.
- 앱이 로그인 토큰으로 Edge Function `calendar-today`를 부르면 그때 Google에서 읽어 돌려줌. **일정 내용은 DB에 저장하지 않음**
- 아침 9시 알림 첫 줄에 "오늘 일정 3개 · 10:00 교역자 회의" 추가 (선택)

## 4. 새로 생기는 것

| 종류 | 이름 | 내용 |
|---|---|---|
| 테이블 | `calendar_connections` | 사용자, Google 이메일, Steward 캘린더 id, 상태(연결됨/다시 연결 필요), 마지막 동기화·오류. 토큰 없음 |
| 테이블 | `calendar_sync_queue` | 업무 id, 할 일(맞추기/지우기), 시도 횟수, 다음 시도 시각 |
| 테이블 | `oauth_states` | 연결 시작 확인용 1회성 값 (10분 만료) |
| 함수 | `calendar-auth`, `sync-calendar`, `calendar-today` | Edge Function 3개 |
| 예약 | `steward-calendar-sync` | 매분, 할 일 있을 때만 |
| 화면 | 알림 설정 아래 「캘린더」 칸, TODAY 위 일정 목록 | 기존 화면 구조 유지, 칸 추가만 |

앱(로그인 사용자)은 `calendar_connections` 조회만, 큐·state는 접근 불가. 쓰기는 모두 함수 경유.

## 5. 진행 순서 (단계마다 보고 후 다음)

| 단계 | 내용 | DH가 할 일 |
|---|---|---|
| 8-1 | Google Cloud 설정 + 연결/해제 + Steward 캘린더 만들기 | Cloud Console 설정(안내서 제공), 비밀값 2개 입력, 007 실행, 함수 배포 |
| 8-2 | 업무 → 캘린더 동기화 | 008 실행, 함수 배포 |
| 8-3 | TODAY 오늘 일정 + 아침 알림 일정 | 함수 배포 |
| 8-4 | 실제 기기 1주 사용 후 조정 | 사용해 보기 |

## 6. DH 결정 필요

1. **어떤 업무를 올릴까**: 할 날짜(do_date)가 있는 업무 / 기한(due_date)이 있는 업무 / 둘 다
   - 둘 다 있으면 어느 날짜에 올릴지 (할 날짜 권장, 기한은 제목에 "기한 10/30" 표시)
2. **완료하면**: 캘린더에서 지우기 / 「✓ 제목」으로 바꿔 남기기
3. **대기(waiting)·나중(later) 업무**: 올리지 않기(권장) / 다시 확인일(follow_up_date)에 올리기
4. **아침 알림에 일정 넣기**: 넣기 / 넣지 않기

## 7. 교차 검토 요청 포인트

1. `calendar.app.created` + `calendar.events.owned.readonly` 두 범위로 충분하고 가장 좁은지
2. 갱신 토큰을 Vault에, 클라이언트 비밀값을 Edge Function 비밀값에 두는 것
3. 개인용 앱을 「프로덕션」으로 게시하고 "확인되지 않은 앱" 안내를 넘기는 방식
4. 한 방향 동기화(캘린더에서 고친 내용은 덮어씀)
5. `calendar-today`가 일정을 저장하지 않고 매번 Google에서 읽는 것
