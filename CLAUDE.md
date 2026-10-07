# Steward (구 DH Task Hub) — 작업 안내

DH의 개인 업무 허브 웹앱 **Steward**. 태그라인 "A daily rhythm for faithful work." 브랜드: 차분함·책임감·질서·신실함, 딥 네이비, S 모노그램 아이콘(`icons/`). "생각난 일을 5초 안에 기록하고, 아침에 열면 오늘 할 일이 바로 보이는" 것이 목적.
기능 추가보다 매일 쓰기 쉬운 것이 우선.

## 작업 원칙
- 확정된 UI 구조와 데이터 구조를 임의로 바꾸지 않는다. 요청하지 않은 기능은 추가하지 않는다.
- 수정 요청은 해당 부분만 고친다.
- 인증·보안·데이터 구조에 영향을 주는 큰 변경은 구현 전에 DH에게 확인 (DH가 ChatGPT로 교차 검토함).
- 단계가 끝나면 다음 단계로 바로 넘어가지 말고 현재 상태와 테스트 결과를 보고한다.
- 응답과 화면 문구는 자연스러운 한국어.

## 구조
- 정적 사이트 (GitHub Pages). 빌드 없음.
- `index.html` 마크업, `styles.css` 스타일(색·글꼴 토큰, 다크 모드), `app.js` 전체 로직, `config.js` Supabase 주소·공개 키
- `vendor/supabase.js` supabase-js UMD (CDN 의존 없이 번들)
- `supabase/migrations/001_init.sql` DB 스키마·RLS·RPC (설계: `docs/db-design.md`)
- `docs/` 설계 문서 (프로토타입 구조, DB 설계, 체크인 알림 설계)

## 데이터 규칙 (app.js)
- 모든 쓰기는 `patch()` / `insertTask()` / `completeTask()` / `uncompleteTask()`를 거친다.
- 완료·완료 취소는 항상 RPC (`complete_task`, `uncomplete_task`). 반복 업무는 DB가 RPC 외 경로를 거부함.
- 화면 먼저 반영 → 서버 저장 → 서버 값으로 교체. 실패하면 되돌리고 "저장 실패" 표시.
- 텍스트(제목·메모·다음 행동)는 400ms 지연 저장, 시트 닫을 때·페이지 떠날 때 즉시 저장.
- "오늘"은 항상 Asia/Seoul 기준 (`T()`), DB의 `app_today()`와 일치.
- 상태 전환 규칙은 `statusFields()` 한 곳에.

## 테스트
로컬에 PostgreSQL + PostgREST로 Supabase REST·RLS를 재현해 실제 브라우저로 검증.
- `test/server.js`: 앱 정적 파일 + `/rest/v1` → PostgREST 프록시 + 테스트용 config (JWT 직접 발급, 로그인 우회)
- `test/e2e-stage1.js`: Playwright 모바일 크기 E2E, 결과를 DB에서 직접 확인
- 로그인은 이메일+비밀번호 (메일 발송 없음). 실제 로그인 성공은 실제 Supabase Auth에서 확인.

## 진행 단계
1. ✅ 본체 Supabase 연결
2. 해시 라우팅 + 날짜 변경 처리
3. 체크인 화면 3종 (`docs/checkin-design.md`)
4. PWA + 서비스 워커
5. push_subscriptions / notification_log / Cron / Edge Function
6. 실제 기기 테스트
