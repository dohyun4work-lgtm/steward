# Steward 5단계 — 알림 구현 설계안 (교차검토용)

체크인 설계 v2(`docs/checkin-design.md`)를 실제 DB·서버 구조로 옮긴 것. 구현 전 검토용.
- `supabase/migrations/003_notifications.sql` 테이블·권한·함수 (로컬 DB에서 45개 항목 검증 완료)
- `supabase/migrations/004_cron.sql` 매분 예약 + Edge Function 호출 (Supabase 전용 기능이라 로컬 검증 불가)
- Edge Function `send-checkins` 흐름 (아래 4번, 코드는 검토 후 작성)

`tasks`·기존 화면 구조는 변경 없음.

---

## 1. 테이블 (003)

| 테이블 | 내용 | 앱(로그인 사용자) 권한 |
|---|---|---|
| `checkin_slots` | 알림 시간표. 기본 6개 (09·12·15·18·21·23시) | 조회 + **시간·요일·켜기/끄기만** 수정 (열 단위 권한). 종류(kind)·소유자 변경 불가 |
| `notification_prefs` | 전체 알림 ON/OFF (사용자당 1행) | 조회 + `enabled`만 수정 |
| `push_subscriptions` | 기기별 푸시 구독 | 기기 이름·상태만 조회 (**키 값은 다시 내려주지 않음**). 등록·삭제는 함수로만 |
| `notification_log` | 발송 기록 + 중복 방지 | 조회만. 열람·완료 기록은 함수로만 |

제약
- 슬롯 시간: 5분 단위, **23:35까지** (발송 창 20분이 자정을 넘지 않게 → 날짜 계산 단순화)
- 같은 시각 두 슬롯 금지, 요일 0~6 중 1개 이상
- `notification_log` **UNIQUE (slot_id, local_date)** = 슬롯·날짜당 한 번
- 구독 endpoint는 https만, UNIQUE

## 2. 함수

| 함수 | 누가 | 하는 일 |
|---|---|---|
| `ensure_default_slots()` | 앱 | 첫 사용 시 기본 6개 슬롯 + 설정 생성 (이미 있으면 그대로) |
| `register_push_subscription(endpoint, p256dh, auth, label)` | 앱 | 이 기기 구독 등록. 같은 기기면 갱신·다시 활성 |
| `remove_push_subscription(id)` | 앱 | 본인 기기만 삭제 |
| `mark_checkin(log_id, 'opened' \| 'completed')` | 앱 | 알림 눌러 들어옴 / 체크인 끝까지 함. 본인 것만, 처음 한 번만 (1주 후 조정용 데이터) |
| `claim_due_checkins(now)` | Cron | 만료 정리 → 실패 재시도 선점 → 새 슬롯 선점. 이번에 선점한 목록 반환 |
| `begin_sending(log_ids)` | Edge Function | `claimed → sending` 전환에 성공한 것만 반환 |
| `checkin_summary(user, date)` | Edge Function | 알림 문구용 개수 (기한 초과·남음·완료·확인 필요). 제목 없음 |
| `record_push_result(sub_id, ok, gone)` | Edge Function | 기기별 결과. 만료(404·410)면 비활성, 5번 연속 실패면 비활성 |
| `finish_sending(log_id, sent, failed, error)` | Edge Function | 전부 성공 sent / 일부 partial / 전부 실패 failed(2분 뒤 재시도) |
| `dispatch_checkins()` (004) | Cron | 선점 후 보낼 게 있을 때만 Edge Function 호출 |

## 3. 상태·재시도 (설계 v2 7번 그대로)

```
claimed ─(Edge Function이 잡음)→ sending ─→ sent / partial / failed
  │ 3분 안 잡힘                     │ 5분 안 끝남
  ▼                                ▼
failed → 재시도                   unknown (재시도 안 함)
```
- 재시도: failed · 3번 미만 · 실패 2분 뒤 · 슬롯 시각 +20분 안. 지나면 expired
- partial은 재시도 안 함 (성공한 기기에 또 가지 않게)
- 재시도 직전에도 슬롯·전체 설정이 켜져 있는지 다시 확인

## 4. 발송 흐름

```
pg_cron (매분)  →  dispatch_checkins()
                     ├ claim_due_checkins()      DB 안에서 끝. 보낼 게 없으면 종료
                     └ net.http_post → Edge Function send-checkins
                                        헤더 x-steward-cron = Vault 비밀값
Edge Function send-checkins (JWT 검증 끔, 대신 비밀값 헤더 확인)
  1. 헤더 비밀값 확인 (다르면 401)
  2. begin_sending(log_ids) → 실제로 잡은 것만 처리
  3. 기록마다: checkin_summary → 문구 생성 → 사용자의 활성 구독 전체에 Web Push
       payload { title: 'Steward', body, url: './#/checkin/<kind>?d=<날짜>&n=<log_id>', tag: '<kind>-<날짜>' }
       TTL: 체크인 30분, 복기 2시간 / urgency: high
  4. 기기별 record_push_result, 기록별 finish_sending
```
- service_role 키는 Edge Function 안에서만 (Supabase가 자동으로 넣어 줌). 앱·GitHub·AI 어디에도 없음
- VAPID 공개키는 앱 config에, 개인키는 Edge Function 비밀값에만

알림 문구 (개수만, 업무 제목 없음)
| kind | 예 |
|---|---|
| morning | 오늘 할 일 6개 · 기한 초과 1 |
| midday | 남은 업무 4개 · 지금 정리하거나 추가하세요 |
| evening | 남은 업무 3개 · 오늘 안에 할 것만 남겨요 |
| evening_final | 남은 업무 2개 · 내일로 넘기고 오늘을 마무리해요 |
| review | 오늘 완료 7개 · 하루를 1분만 돌아봐요 |

## 5. 앱 쪽 (구현 예정)
- 보관 탭 아래 "알림 설정" → `#/settings`
  - 전체 ON/OFF, 이 기기 알림 켜기(권한 요청은 버튼 누를 때만), 다른 기기 목록·삭제, 테스트 알림
  - 슬롯 6개: 시간(5분 단위)·요일·켜기/끄기, 즉시 저장
  - iPhone이 홈 화면 앱이 아니면 "홈 화면에 추가한 앱에서만 켤 수 있어요" 안내
- 알림으로 들어오면 주소의 `n`으로 `mark_checkin(n,'opened')`, 체크인 끝나면 `'completed'`

## 6. 로컬 검증 (003, 45개 통과)
슬롯 기본값·멱등 / 시간 변경 가능·종류 변경 불가 / 5분 단위·23:35 제한 / 같은 시각 금지 / 다른 사용자·비로그인 차단 / 구독 등록·중복 없음·https만 / 키 값 재조회 불가 / 남의 기기 삭제 불가 / 앱·비로그인은 선점 불가 / 시간 창 전후 / 같은 슬롯 하루 한 번 / 끈 슬롯·뺀 요일·전체 OFF·구독 없음이면 선점 안 함 / 발송 시작 한 번만 / 실패 → 2분 뒤 재시도 → 3번 한도 → 20분 지나면 expired / claimed 3분 멈춤 → 재시도 / sending 5분 멈춤 → unknown / partial 재시도 안 함 / 410 → 기기 비활성, 다시 켜면 활성, 5번 연속 실패 → 비활성 / 열람·완료 기록 본인·한 번만 / 발송 기록 직접 수정 불가 / 문구용 개수

## 7. 검토 요청 포인트
1. 열 단위 권한(시간·요일·켜기만 수정)과 함수 경유 등록이 충분한지
2. 같은 기기에서 계정을 바꿨을 때 구독을 새 계정으로 옮기는 동작(혼자 쓰는 앱이라 단순하게 둠)
3. 슬롯 시간을 23:35까지로 제한한 것 (자정 넘는 창을 피하려고)
4. dispatch에서 Edge Function 호출이 실패하면 claimed로 남겨 3분 뒤 재시도에 맡기는 것
5. Edge Function을 JWT 검증 없이 두고 Vault 비밀값 헤더로만 확인하는 것
6. `checkin_summary`가 tasks를 사용자 기준으로 직접 세는 것 (security definer, service_role 전용)

## 8. 구현 시 DH가 할 일 (예상)
- Supabase 대시보드: pg_cron · pg_net 켜기
- Edge Function 비밀값 등록 (VAPID 개인키, CRON_SECRET) — 값은 제가 만들어 드리고 대시보드에 직접 붙여넣기
- Vault 비밀값 2개 등록 (SQL 한 줄씩)
