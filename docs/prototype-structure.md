# DH Task Hub 프로토타입 — 구조 설명 (v2)

검수용 문서. 코드는 `dh-task-hub.html` 한 파일(HTML + CSS + JS, 외부 라이브러리 없음).
목적은 사용성 검증이며, Supabase·로그인·PWA는 의도적으로 제외함.

## 0. v2 변경 사항 (ChatGPT 검수 반영)

| # | 내용 |
|---|---|
| ② | 오늘 마감(`due_date = 오늘`) 업무는 할 날과 관계없이 TODAY에 표시. 상세에서 할 날이 마감보다 늦으면 경고 |
| ③ | 마감일을 **상태와 관계없는 절대 마감**으로 변경. 인박스·대기·나중에 업무도 마감이 오늘이거나 지나면 TODAY에 올라옴 (행에 현재 상태 표시) |
| ④ | 이번 주 보기에서 ＋ 누르면 기본값이 "이번 주" |
| ⑤ | 상세 → 대기 설정 → 취소해도 상세로 복귀 |
| ⑥ | 다른 상태에서 "진행"으로 바꾸면 할 날을 오늘로 설정 (예전 날짜를 되살리지 않음) |
| ⑦ | 인박스 "건너뛰기"는 정리 세션 안의 순서만 바꿈. `created_at`은 수정하지 않음 |
| ⑫ | 이미 완료된 업무는 다시 완료 처리 안 됨 + 완료 직후 버튼 비활성화 (반복 업무 중복 생성 방지) |
| ⑭ | 대기에서 벗어나면(진행·나중·완료) `waiting_for`, `follow_up_date` 비움. 최근 대상 이름은 별도 목록으로 관리 |
| ⑮ | 저장 실패 시 "이 기기에 저장 안 됨" 표시 |

## 1. 파일 구성 (dh-task-hub.html)

| 블록 | 내용 |
|---|---|
| `<style>` | 색상·글꼴 토큰(:root, 다크 모드 포함), 행·시트·네비·토스트 스타일 |
| `.app` > `#top`, `#main` | 상단 헤더(화면 제목·토글), 목록 영역 |
| `.nav` | 하단 네비: 오늘 / 인박스(배지) / ＋ / 대기 / 보관 |
| `#sheet`, `#scrim` | 하단 시트 1개를 내용만 바꿔 재사용 |
| `#toast` | 5초 토스트 + 되돌리기 |
| `<script>` | 데이터, 날짜 계산, 화면 렌더링, 동작, 시트, 밀기 제스처 |

## 2. 데이터 모델

```
id, title, status, area, do_date, due_date, starred,
next_action, waiting_for, follow_up_date, memo, repeat,
created_at, updated_at, done_at, deleted_at, source, calendar_event_id
```

- status: `inbox | active | waiting | later | done`
- area: `TLC | LEVITES | MEDIA | ADMIN | PERSONAL | null`
- repeat: `weekly | monthly | null`
- 날짜는 `YYYY-MM-DD` 문자열(기기 로컬 시간), 타임스탬프는 ISO 문자열
- 삭제는 `deleted_at`만 기록(숨김)
- 저장: `localStorage` 키 `dh-task-hub-proto-v1`, 최근 대기 대상은 `-who` 키

**상태 전환 규칙 (`setStatus`)**
- → active: 다른 상태에서 오면 `do_date = 오늘`. active인데 `do_date`가 없어도 오늘로.
- → waiting: `follow_up_date` 없으면 3일 후.
- waiting 이외로 전환: `waiting_for`, `follow_up_date` 비움.
- → done: `done_at` 기록 (완료는 `complete()`를 거쳐 반복 처리).

## 3. 화면 규칙 (자동 계산)

"열린 업무" = inbox, active, waiting, later

| 화면/구역 | 조건 |
|---|---|
| 기한 초과 | 열린 업무 중 `due_date < 오늘` |
| 오늘 | (active 이고 `do_date ≤ 오늘`) 또는 (열린 업무 중 `due_date = 오늘`), 기한 초과 제외 |
| 확인 필요 | waiting 이고 `follow_up_date ≤ 오늘`, 위 두 구역에 이미 나온 것 제외 |
| 이번 주 | 기한 초과 + 오늘~이번 주 일요일 요일별 (active는 할 날 기준, 그 외 상태는 마감 기준) + "다음 주 이후" 접기 |
| 인박스 | status = inbox, 오래된 순 |
| 대기 | status = waiting, 대상별 묶음 |
| 보관 | 나중에 / 완료(완료일별) 토글 |

정렬: 별표 → do_date → 만든 순서. 주 기준은 월~일.

## 4. 주요 동작

| 동작 | 결과 |
|---|---|
| 완료 (동그라미 / 오른쪽 밀기) | done + done_at, 1.2초 취소선 후 사라짐, 토스트 되돌리기. 이미 done이면 무시 |
| 반복 업무 완료 | 다음 주기(오늘 이후 첫 날짜)로 새 업무 생성. 되돌리기 시 생성분도 삭제 |
| 미루기 (왼쪽 밀기) | 내일 / 이번 주(일) / 다음 주(월) / 날짜 선택 / 나중에 / 대기로 |
| 대기 전환 | 최근 대상 칩 5개 + 직접 입력, 확인일 기본 3일 후. 상세에서 열었으면 완료·취소 모두 상세로 복귀 |
| 확인 필요 [받음] | 진행 + 오늘, 대기 정보 비움 |
| 확인 필요 [다시 미루기] | 내일 / 3일 후 / 다음 주 |
| 인박스 정리 | 시작 시점의 인박스 목록을 큐로 만들어 한 장씩 처리. 건너뛰기는 큐 맨 뒤로 |
| 빠른 추가 | 업무명만 필수. 기본값: 오늘 보기 → 오늘, 이번 주 보기 → 이번 주, 그 외 → 인박스. 엔터 후 시트 유지 |
| 상세 | 모든 변경 즉시 저장. 다음 행동·반복은 "더보기" 안 |
| 삭제 | 숨김 처리 + 토스트 되돌리기 |

## 5. 의도적으로 뺀 것

- PC 3단 레이아웃 (PC에서는 휴대폰 폭으로 가운데 표시)
- 검색, 필터, 통계, 알림, 캘린더 연동
- 서버 저장, 로그인, PWA 설치
- 확인 대화상자 (모두 되돌리기로 대체)

## 6. 알고 있는 한계 (프로토타입 한정)

- 되돌리기는 마지막 동작 1개만 가능
- 텍스트 입력은 글자마다 저장(localStorage라 문제없음, 실제 앱에서는 debounce 필요)
- 월간 반복은 직전 날짜 기준이라 31일 → 2/28 → 3/28로 밀릴 수 있음
- 자정을 넘겨도 화면을 다시 그리기 전까지 날짜 갱신 안 됨

## 7. 실제 앱(Supabase) 전환 시 필수 — 프로토타입에서는 구현 안 함

**P0**
1. DB 제약: `status = 'active'` → `do_date NOT NULL` (CHECK). 조회에서도 위반 데이터는 "미정"으로 노출
2. `created_at` 불변 (트리거로 수정 차단 권장)
3. `user_id uuid references auth.users(id)` + 모든 SELECT/INSERT/UPDATE/DELETE에 `auth.uid() = user_id` RLS
4. 반복 완료는 Postgres function(RPC) 하나로 트랜잭션 처리
5. 반복 중복 생성 방지: `series_id + occurrence_date` UNIQUE
6. 완료는 서버에서도 `status <> 'done'` 조건부 UPDATE (중복 완료 방지)

**P2**
7. 날짜 컬럼 `date`, 타임스탬프 `timestamptz`
8. 텍스트 자동 저장 300~500ms debounce, 칩·상태·날짜는 즉시 저장
9. 월간 반복 기준일 저장 (`repeat_anchor_day`)
10. "저장됨"은 서버 응답 성공 후에만, 실패 시 "저장 실패 · 재시도"
