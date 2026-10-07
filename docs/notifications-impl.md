# Steward 5단계 — 알림 구현 설계 (교차검토 반영 v2)

체크인 설계 v2(`docs/checkin-design.md`)를 실제 DB·서버 구조로 옮긴 것.

**v2 (ChatGPT 검토 반영)**: ① 구독 이전 정책 문서화 ② HTTP 실패 → 3분 timeout 재시도 유지 ③ CRON 비밀값: DB 안에서 256비트 난수 생성, Edge Function은 DB에 확인만 요청(값 복사 없음), 로그 금지, 한 줄 교체 ④ `cron.schedule` 같은 이름 갱신을 실제 pg_cron 1.6에서 확인, 004 반복 실행 안전
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

## 1-1. 구독 이전 정책 (같은 기기, 다른 계정)

같은 브라우저·기기의 푸시 주소(endpoint)는 계정과 상관없이 하나다. Steward는 endpoint를 UNIQUE로 두고, **다른 계정이 같은 endpoint를 등록하면 그 구독을 새 계정으로 옮긴다** (`register_push_subscription`의 `on conflict (endpoint) do update set user_id = …`).

| 상황 | 결과 |
|---|---|
| 같은 계정이 다시 켬 | 같은 행 갱신, 비활성이었다면 다시 활성 |
| 기기에서 계정 A → 로그아웃 → 계정 B로 로그인 후 알림 켬 | 구독이 B로 이전. **A는 그 기기로 더 이상 알림을 받지 않음** |
| B가 알림을 켜지 않음 | 구독은 A에 그대로 → 그 기기에 A의 알림이 계속 옴 (알림에는 개수만, 업무 제목 없음) |

- 개인용 MVP(사용자 1명)라 이 정책으로 충분. 여러 사람이 한 기기를 나눠 쓰는 경우는 범위 밖.
- 로그아웃 시 그 기기 구독을 해제하는 동작은 앱에서 처리 (로그아웃 → `remove_push_subscription` + 브라우저 구독 취소). 그래서 위 3번째 줄은 로그아웃 없이 계정이 바뀌는 예외 상황에서만 생김.

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
| `verify_cron_secret(secret)` (004) | Edge Function | 받은 헤더가 Vault 값과 같은지 확인 (해시 비교, 값은 반환·기록 안 함) |

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
  1. 헤더 x-steward-cron을 verify_cron_secret()으로 DB에 확인 (다르면 401). 헤더 값은 로그에 남기지 않음
  2. begin_sending(log_ids) → 실제로 잡은 것만 처리
  3. 기록마다: checkin_summary → 문구 생성 → 사용자의 활성 구독 전체에 Web Push
       payload { title: 'Steward', body, url: './#/checkin/<kind>?d=<날짜>&n=<log_id>', tag: '<kind>-<날짜>' }
       TTL: 체크인 30분, 복기 2시간 / urgency: high
  4. 기기별 record_push_result, 기록별 finish_sending
```
- service_role 키는 Edge Function 안에서만 (Supabase가 자동으로 넣어 줌). 앱·GitHub·AI 어디에도 없음

### CRON 비밀값 (v2)
| 항목 | 방식 |
|---|---|
| 생성 | 004 실행 시 DB 안에서 `gen_random_bytes(32)` → 64자리 16진수(256비트). 없을 때만 생성, 다시 실행해도 유지 |
| 보관 | Vault 한 곳뿐. Edge Function 환경 변수에 복사하지 않음 → 사람·채팅·파일을 거치지 않음 |
| 확인 | Edge Function이 `verify_cron_secret(헤더)` 호출. SHA-256 해시끼리 비교, 64자 아니면 거부 |
| 로그 | `dispatch_checkins`의 경고, Edge Function 로그 모두 비밀값을 넣지 않음 (로컬 테스트로 확인) |
| 교체 | `vault.update_secret(...)` 한 줄. 재배포 불필요, 즉시 적용. 교체 순간 진행 중이던 호출은 실패 → 3분 뒤 재시도 |
| 참고 | pg_net은 요청을 보내기 전까지 `net.http_request_queue`에 헤더를 잠시 보관함 |

### 예약 반복 실행 (v2)
- 실제 pg_cron 1.6(Supabase와 같은 버전)에서 확인: `cron.schedule('steward-checkins', …)`을 다시 부르면 **같은 jobid의 일정·명령이 갱신**되고 중복 job이 생기지 않음. Supabase 문서도 같은 이름은 덮어쓴다고 명시.
- 반대로 `cron.unschedule('없는 이름')`은 오류를 내므로 004에서는 쓰지 않음.
- 004를 세 번 연속 실행해도 오류 없이 job 1개, 비밀값 유지 (로컬 테스트).
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

## 6-1. 004 로컬 검증 (21개 통과)
실제 pg_cron 1.6 + Vault·pg_net 흉내로 004 파일 자체를 실행: 세 번 실행해도 오류·중복 없음 / job 1개·매분·명령 맞음 / 비밀값 64자리·재실행 시 유지·1개 / 헤더 확인 맞음·틀림·빈 값·짧은 값·null / 앱·비로그인 실행 불가 / 보낼 게 있을 때만 호출·헤더와 본문 / 주소 없으면 호출 안 함·기록은 claimed로 남음 / 경고에 비밀값 없음 / 한 줄 교체·이전 값 즉시 거부·재실행해도 새 값 유지

## 7. 검토 요청 포인트 (v1, 검토 완료)
1. 열 단위 권한(시간·요일·켜기만 수정)과 함수 경유 등록이 충분한지
2. 같은 기기에서 계정을 바꿨을 때 구독을 새 계정으로 옮기는 동작(혼자 쓰는 앱이라 단순하게 둠)
3. 슬롯 시간을 23:35까지로 제한한 것 (자정 넘는 창을 피하려고)
4. dispatch에서 Edge Function 호출이 실패하면 claimed로 남겨 3분 뒤 재시도에 맡기는 것
5. Edge Function을 JWT 검증 없이 두고 Vault 비밀값 헤더로만 확인하는 것
6. `checkin_summary`가 tasks를 사용자 기준으로 직접 세는 것 (security definer, service_role 전용)

## 8. 구현 시 DH가 할 일 (예상)
- Supabase 대시보드: pg_cron · pg_net 켜기
- Edge Function 비밀값 등록: VAPID 개인키 하나 (CRON 비밀값은 004가 자동 생성)
