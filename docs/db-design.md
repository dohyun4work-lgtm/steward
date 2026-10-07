# DH Task Hub — Supabase 데이터·보안 설계안 v2 (최종)

교차 검토용 문서. 실제 SQL은 `task-hub-schema.sql` (한 번에 실행하는 마이그레이션 형태).
UI 구조는 프로토타입 v2 그대로 유지하며, 연결 코드는 아직 없음.

## v2 변경 사항 (ChatGPT 검토 4건 반영)

| # | 문제 | 수정 |
|---|---|---|
| 1 | 반복 업무를 일반 UPDATE로 done 처리하면 다음 회차가 안 생김 | 반복 업무의 완료·완료 취소는 `complete_task` / `uncomplete_task` RPC로만 가능. 트리거가 그 외 경로를 거부. 반복 업무를 done 상태로 바로 INSERT하는 것도 거부 |
| 2 | 연동 키 UPDATE 정책이 다른 컬럼 수정도 허용 | 앱 사용자의 integration_keys 직접 INSERT·UPDATE·DELETE 권한 회수. 조회만 가능, 폐기는 `revoke_integration_key(id)` RPC로만 |
| 3 | AI가 DB REST 주소로 ai_* 함수를 직접 호출하는 구조 | 최종 구조를 **AI → Edge Function → DB**로 확정. ai_* 함수는 service_role만 실행 가능. MVP에서는 Edge Function을 만들지 않으므로 사실상 아무도 호출 못 하는 상태 |
| 4 | 반복 해제 후 재설정 시 시리즈 규칙 불명확 | 반복을 새로 켜거나 규칙을 바꾸면 **새 시리즈**. 끄면 기존 시리즈는 기록으로만 남음. series_id·occurrence_date는 앱이 직접 수정 불가 |

---

## 1. tasks 테이블

| 컬럼 | 타입 | NULL | 기본값 | 비고 |
|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK |
| user_id | uuid | NO | auth.uid() | auth.users 참조, 변경 불가 |
| title | text | NO | | 1~500자, 앞뒤 공백 제거 |
| status | text | NO | 'inbox' | inbox / active / waiting / later / done |
| area | text | YES | | TLC / LEVITES / MEDIA / ADMIN / PERSONAL |
| do_date | date | YES | | active면 필수 |
| due_date | date | YES | | 상태와 무관한 절대 마감 |
| starred | boolean | NO | false | |
| next_action | text | YES | | |
| memo | text | NO | '' | 10,000자 이하 |
| waiting_for | text | YES | | waiting일 때만 값, 그 외 반드시 NULL |
| follow_up_date | date | YES | | waiting일 때만 값, 그 외 반드시 NULL |
| repeat_rule | text | YES | | weekly / monthly |
| repeat_anchor_day | smallint | YES | | 매월 반복 기준일 1~31 |
| series_id | uuid | YES | | 반복 시리즈 묶음. 트리거만 설정, 앱 직접 수정 불가 |
| occurrence_date | date | YES | | 반복 일정상 회차 날짜, 미뤄도 그대로. 트리거만 설정 |
| source | text | NO | 'manual' | manual / ai / calendar / repeat, 변경 불가 |
| calendar_event_id | text | YES | | 연동 대비 |
| created_at | timestamptz | NO | now() | 서버가 정함, 변경 불가 |
| updated_at | timestamptz | NO | now() | 수정 시 자동 갱신 |
| done_at | timestamptz | YES | | done일 때만 값 |
| deleted_at | timestamptz | YES | | soft delete |

프로토타입 대비 바뀐 점: `repeat` → `repeat_rule` + `repeat_anchor_day` + `series_id` + `occurrence_date` (반복 중복 방지와 월말 기준 유지를 위해), `user_id` 추가, 날짜는 `date`, 시각은 `timestamptz`.

enum 대신 `text + CHECK`를 쓴 이유: 분야나 상태를 나중에 추가할 때 CHECK만 바꾸면 돼서 관리가 쉬움.

---

## 2. 데이터 규칙 — 2중 방어

**1차: 정규화 트리거** (`tasks_normalize`, 저장 직전에 실행)
| 상황 | 처리 |
|---|---|
| active인데 do_date 없음 | 오늘(한국 시간)로 채움 |
| waiting인데 follow_up_date 없음 | 3일 후로 채움 |
| waiting이 아닌 상태 | waiting_for, follow_up_date 비움 |
| done | done_at 없으면 지금. done이 아니면 done_at 비움 |
| 반복 설정 | series_id, occurrence_date, 매월이면 anchor 자동 채움 |
| INSERT | created_at, updated_at을 서버 시각으로 덮어씀 |
| UPDATE | created_at, user_id, source, series_id, occurrence_date 변경 시도 → 오류 |
| 반복 업무 완료·완료 취소 | RPC 경유가 아니면 오류 (아래 5번) |
| 반복 켜기 / 규칙 변경 | 새 시리즈 시작 (아래 5번) |

**2차: CHECK 제약** (트리거를 우회해도 DB가 거부)
- `status <> 'active' or do_date is not null`
- waiting ↔ (waiting_for, follow_up_date) 둘 다 있음 / 둘 다 없음
- `(status = 'done') = (done_at is not null)`
- 반복이면 series_id, occurrence_date 필수

"다른 상태에서 진행으로 오면 오늘로" 같은 UX 규칙은 앱이 do_date를 명시해서 보냄. DB는 "할 날 없는 진행 업무"가 존재하지 않게만 보장.

---

## 3. 소유권과 RLS

- 모든 행에 `user_id`, 기본값 `auth.uid()`.
- `anon`(비로그인): tasks, recent_waiting, integration_keys 테이블 접근 권한 자체를 회수.
- `authenticated`: 아래 정책으로 본인 행만.

| 정책 | 대상 | 조건 |
|---|---|---|
| select | 본인 행 (삭제된 행 포함, 되돌리기 복원용) | `user_id = auth.uid()` |
| insert | 본인 행, source는 manual/calendar/repeat만 | `user_id = auth.uid()` |
| update | 본인 행, 소유자 변경 불가 | using + with check 모두 `user_id = auth.uid()` |
| delete | **없음** + DELETE 권한 회수 | 실제 삭제 불가, soft delete만 |

`auth.uid()`는 `(select auth.uid())`로 감싸서 행마다 다시 계산하지 않게 함 (Supabase 권장 방식).

추가로 Supabase 설정에서 할 것:
- Auth → 본인 계정 만든 뒤 **신규 가입 비활성화**
- `service_role` 키는 앱 코드·GitHub·AI 어디에도 넣지 않음

---

## 4. 인덱스

| 인덱스 | 용도 |
|---|---|
| (user_id, do_date) where active | TODAY / THIS WEEK |
| (user_id, due_date) where 열린 업무 + 마감 있음 | 기한 초과 / 오늘 마감 |
| (user_id, follow_up_date) where waiting | 확인 필요 / 대기 |
| (user_id, status, created_at) | 인박스 / 나중에 |
| (user_id, done_at desc) where done | 완료 목록 |
| **UNIQUE (series_id, occurrence_date)** where 삭제 안 됨 | 반복 중복 생성 방지 |

개인용이라 데이터가 수천 건 수준이면 인덱스 없이도 빠름. 반복 UNIQUE만 필수이고 나머지는 저비용 보험.

---

## 5. 반복 업무

**완료 경로 강제 (v2)**
- 반복 업무(또는 반복이었던 업무)의 done ↔ 미완료 전환은 RPC 안에서만 허용.
- 방식: RPC가 같은 트랜잭션 안에서만 유효한 표시(`app.rpc_task_id` = 대상 id)를 걸고 수정 → 트리거가 이 표시가 없으면 거부.
- 이 표시는 트랜잭션이 끝나면 사라지고, Supabase REST는 `set_config` 같은 내장 함수를 외부에 노출하지 않아 앱에서 흉내 낼 수 없음.
- 반복 아닌 업무는 일반 UPDATE로 완료해도 됨. 다만 **앱에서는 모든 완료·완료 취소를 RPC로 통일**하는 것을 권장 (코드 경로가 하나라 단순).

**완료: `complete_task(id)` RPC** — 한 트랜잭션
1. `status <> 'done'`인 경우에만 done으로 변경 → 이미 완료면 `{completed: false}` 반환 (중복 완료 방지)
2. 반복이면 다음 회차 생성, `ON CONFLICT (series_id, occurrence_date) DO NOTHING` (네트워크 재시도에도 하나만)
3. 다음 마감은 원래 "할 날 ↔ 마감" 간격을 유지

**다음 날짜 계산** (`next_occurrence`)
- 매주: +7일, 매월: 기준일 유지 (1/31 → 2/28 → **3/31**)
- 오늘 이후 첫 회차까지 건너뜀 (밀린 회차를 한꺼번에 만들지 않음)
- 기준은 `occurrence_date` (업무를 미뤄도 반복 일정은 원래대로)

**시리즈 규칙 (v2)**
| 상황 | 결과 |
|---|---|
| 반복 없음 → 매주/매월 | 새 series_id, 회차 = 현재 할 날(없으면 오늘), 매월이면 기준일 = 그 날짜의 일 |
| 매주 ↔ 매월 변경 | 새 시리즈 (위와 같음) |
| 반복 끄기 | series_id·occurrence_date는 기록으로 남김, 기준일만 비움 |
| 끈 뒤 다시 켜기 | 새 시리즈. 예전 시리즈를 이어가지 않음 |
| 같은 규칙에서 할 날만 미루기 | 시리즈·회차 그대로 |
| complete_task가 만든 다음 회차 | 같은 시리즈 유지 |

**되돌리기: `uncomplete_task(id)` RPC**
- 진행으로 복원
- 이 완료로 자동 생성된 다음 회차가 **생성 후 수정되지 않았으면** soft delete. 수정했으면 남김.

---

## 6. 시간대

Supabase 서버는 UTC. `current_date`를 쓰면 한국 오전 9시 전까지 "오늘"이 하루 전으로 계산됨.
→ 모든 날짜 계산은 `app_today()` = `(now() at time zone 'Asia/Seoul')::date` 사용.

---

## 7. "오늘" 조회 — 규칙을 한 곳에

`today_items(user)` 함수가 프로토타입 v2 규칙을 그대로 구현. 앱(`get_today()`)과 AI(`ai_get_today()`)가 같은 함수를 써서 화면과 AI 답이 어긋나지 않음.

| bucket | 조건 |
|---|---|
| overdue | 열린 업무 중 due_date < 오늘 |
| today | due_date = 오늘, 또는 active이고 do_date ≤ 오늘 |
| follow_up | waiting이고 follow_up_date ≤ 오늘 (위 두 개에 해당하지 않는 것) |

---

## 8. AI 연동 권한 구조

**최종 구조 (v2)**

```
앱(DH)  ──로그인 + RLS──────────────▶ Supabase DB        (지금처럼 직접 연결)
AI      ──연동 키──▶ Edge Function ──service_role──▶ ai_* 함수 ──▶ DB
```

- AI가 아는 것: Edge Function 주소 + 연동 키뿐. DB 주소·service_role 키는 모름.
- Edge Function: 연동 키를 받아 ai_* 함수에 그대로 넘김. 키 검증·scope 확인·입력 제한은 DB 함수가 계속 담당(로직 재사용).
- Edge Function에서 추가로 할 수 있는 것: ChatGPT용 API 명세 제공, 요청 로그, 호출 빈도 제한, 응답 모양 정리.
- ai_* 함수 실행 권한은 service_role만. 비로그인·로그인 사용자 모두 직접 호출 불가.
- **MVP에서는 Edge Function을 만들지 않음.** 함수와 키 테이블만 준비해 두고, 연동은 앱 안정화 후.

**원칙**: AI에게 로그인 세션도 service_role 키도 주지 않는다. 기능별 "연동 키"로 정해진 두 가지만 허용.

| 함수 | 필요 범위 | 하는 일 |
|---|---|---|
| `ai_get_today(key)` | today:read | 오늘 목록 JSON 반환 (읽기 전용) |
| `ai_add_inbox(key, title, memo)` | inbox:add | 인박스에 추가. status='inbox', source='ai' 고정 |

- 키 발급: 로그인 상태에서 `create_integration_key('ChatGPT', ['today:read','inbox:add'])` → 원문 키는 **이때 한 번만** 보임. DB에는 SHA-256 해시만 저장.
- 폐기: `revoke_integration_key(id)` RPC로만 (본인 키만). 키 테이블은 앱에서 조회만 가능하고 직접 수정·추가·삭제 불가.
- AI는 완료·삭제·상태 변경·날짜 변경 불가. 기존 원칙("중요한 변경은 DH 확인 후")과 맞춤.
- 제한: 제목 1~200자, 메모 2,000자, 시간당 30건.
- 키 원문은 `dhth_` + 64자리 난수라 추측 불가.

**함수 실행 권한**: Supabase는 public 함수를 기본으로 누구나 실행 가능하게 열어 두므로, 전부 닫은 뒤 필요한 것만 열었음.
- 로그인 사용자: complete_task, uncomplete_task, get_today, today_items, next_occurrence, app_today, create_integration_key, revoke_integration_key
- service_role(Edge Function 전용): ai_get_today, ai_add_inbox
- 비로그인: 실행 가능한 함수 없음
- 내부 함수(`_resolve_key`), 트리거 함수: 직접 실행 불가

---

## 9. 로컬 검증 결과

PostgreSQL 16에 Supabase의 auth·역할 구조를 흉내 낸 환경을 만들어 SQL 전체를 실행하고 확인함. (실제 Supabase에서 한 번 더 확인 필요)

| 확인 항목 | 결과 |
|---|---|
| 스키마 전체 실행 | 오류 없음 |
| active + do_date 없음 (insert / update) | 오늘로 자동 채움 |
| 대기 해제 시 대기 정보 | 비워짐, 최근 대상 목록에는 남음 |
| created_at 수정 시도 | 거부 |
| 앱에서 source='ai' 직접 입력 | RLS로 거부 |
| 실제 DELETE | 권한 없음으로 거부 |
| 반복 업무 두 번 완료 | 두 번째는 `completed: false`, 다음 회차 1개만 |
| 매월 31일 반복 | 1/31 → 2/28 → 3/31 |
| 완료 되돌리기 | 원래 업무 복원 + 자동 생성 회차 제거, 다시 완료 가능 |
| 오늘 마감 + 할 날 미래 / 인박스 오늘 마감 / 나중에 기한 지남 | 모두 TODAY에 표시 |
| 다른 사용자 | 0건 조회, 수정 0건 |
| 비로그인 테이블 직접 조회 | 거부 |
| 비로그인 + 올바른 키 | 오늘 읽기·인박스 추가 성공 |
| 틀린 키 / 빈 제목 | 거부 |
| 비로그인으로 complete_task | 거부 |
| integration_keys 직접 insert | 거부 (발급 함수로만) |

**v2 추가 검증**
| 확인 항목 | 결과 |
|---|---|
| 반복 업무 직접 UPDATE로 done | 거부 |
| 반복 업무를 done으로 바로 INSERT | 거부 |
| 반복 업무 RPC 완료 | 성공, 다음 회차 1개 |
| 완료된 반복 업무 직접 UPDATE로 되돌리기 | 거부 |
| 반복 업무 RPC 되돌리기 | 성공 |
| 반복 아닌 업무 직접 완료 | 허용 (done_at 자동 기록) |
| RPC 호출 직후 다른 반복 업무 직접 done | 거부 (표시가 남지 않음) |
| integration_keys 직접 UPDATE | 권한 없음 |
| 키 폐기 RPC | 첫 호출 true, 두 번째 false |
| 다른 사용자 키 폐기 | false (변경 없음) |
| 폐기된 키로 ai_get_today | 거부 |
| ai_* 함수: 로그인 사용자 / 비로그인 직접 호출 | 모두 권한 없음 |
| ai_* 함수: service_role 호출 | 성공 |
| 반복 끄기 | series_id 기록 유지 |
| 다시 켜기 / 매주 → 매월 | 매번 새 series_id, 회차·기준일 새로 설정 |
| series_id 직접 수정 | 거부 |
| 같은 규칙에서 할 날만 미루기 | 시리즈·회차 유지 |
| v1 검증 항목 재실행 | 모두 동일하게 통과 |

---

## 10. 다음 단계

1. Supabase 프로젝트 생성 (리전: 서울 `ap-northeast-2`)
2. SQL Editor에서 `task-hub-schema.sql` 전체 실행
3. Auth 설정: 이메일(또는 구글) 로그인 → 본인 계정 생성 → 신규 가입 비활성화
4. 실제 Supabase에서 핵심 검증 몇 가지 재확인 (다른 계정 접근 차단, 반복 완료)
5. 앱 연결 (프로토타입 v2 UI 유지)

## 11. 아직 안 정한 것

- 삭제된 업무 영구 보관 기간
- AI 시간당 추가 한도(현재 30건)가 적절한지
- 자정 넘김 처리(앱이 열려 있는 상태에서 날짜가 바뀔 때 화면 갱신)는 앱 코드에서 처리 예정
