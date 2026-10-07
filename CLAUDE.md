# Steward (구 DH Task Hub) — 작업 안내

DH의 개인 업무 허브 웹앱 **Steward**. 태그라인 "A daily rhythm for faithful work." 브랜드: 차분함·책임감·질서·신실함, 딥 네이비, S 모노그램 아이콘(`icons/`). "생각난 일을 5초 안에 기록하고, 아침에 열면 오늘 할 일이 바로 보이는" 것이 목적.
기능 추가보다 매일 쓰기 쉬운 것이 우선.

- 앱 주소: https://dohyun4work-lgtm.github.io/steward/ (GitHub Pages, main 브랜치 루트)
- Supabase 프로젝트: `mqmcpsuaurpajsfjryon` (서울). 로그인은 이메일+비밀번호, 신규 가입 꺼짐.

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
- `sw.js` 서비스 워커: 같은 도메인 GET만, `/rest|auth|functions|storage|realtime/v1/`는 절대 가로채지 않음. 셸 파일을 바꾸면 `VERSION`도 올릴 것(새 캐시)
- `manifest.webmanifest`, `icons/` (192·512·maskable·apple-touch·badge-96)
- `supabase/functions/send-checkins/index.ts` 발송 Edge Function (Deno). JWT 검증 끔, `x-steward-cron`을 `verify_cron_secret()`으로 확인. VAPID 키는 스스로 만들어 Vault에 저장(005), `GET ?vapid=public`으로 공개키만 제공. 비밀값·구독 주소는 로그 금지
- 알림 설정 화면 `#/settings` (보관 탭 아래). 구독 id는 localStorage `steward.push.subscriptionId`. 로그아웃하면 이 기기 구독 해제
- `supabase/migrations/` DB 스키마·RLS·RPC, 번호 순서대로 실행 (001 기본, 002 하루 복기). 설계: `docs/db-design.md`
- 새 마이그레이션은 앱 배포 **전에** 실제 Supabase에 먼저 실행 (앱이 새 테이블을 바로 읽음)
- `docs/` 설계 문서 (프로토타입 구조, DB 설계, 체크인 알림 설계)

## 데이터 규칙 (app.js)
- 모든 쓰기는 `patch()` / `insertTask()` / `completeTask()` / `uncompleteTask()`를 거친다.
- 완료·완료 취소는 항상 RPC (`complete_task`, `uncomplete_task`). 반복 업무는 DB가 RPC 외 경로를 거부함.
- 화면 먼저 반영 → 서버 저장 → 서버 값으로 교체. 실패하면 되돌리고 "저장 실패" 표시.
- 텍스트(제목·메모·다음 행동)는 400ms 지연 저장, 시트 닫을 때·페이지 떠날 때 즉시 저장.
- "오늘"은 항상 Asia/Seoul 기준 (`T()`), DB의 `app_today()`와 일치.
- 상태 전환 규칙은 `statusFields()` 한 곳에.
- 주소는 해시 라우팅 (`ROUTES`): `#/today` `#/today/week` `#/inbox` `#/waiting` `#/archive` `#/archive/done`. 탭 이동은 기록을 남기고, 같은 화면 안 보기 전환은 `replace`.
- 체크인 시트는 `leaveCheckin`으로 닫힐 때 주소를 `#/today`로 되돌림. 상세·대기·미루기는 `back` 콜백으로 원래 체크인 화면에 복귀.
- 날짜 변경: 자정 타이머 + 1분 간격 확인 + 앱 복귀(visibilitychange/pageshow/focus). 날짜가 바뀌면 상세 외 시트는 닫고 다시 불러옴. 앱 복귀 시 30초 넘었으면 서버에서 다시 불러옴(`refresh`는 저장 중인 요청이 끝난 뒤 실행).

## 테스트
로컬에 PostgreSQL + PostgREST로 Supabase REST·RLS를 재현해 실제 브라우저로 검증.
- `bash test/start-local.sh [--reset]`: 로컬 스택 시작 (PostgREST는 GitHub 릴리스에서 내려받음)
- `test/server.js`: 앱 정적 파일 + `/rest/v1` → PostgREST 프록시 + 테스트용 config (JWT 직접 발급, 로그인 우회)
- `test/e2e-stage1.js`: 본체 기능 E2E, 결과를 DB에서 직접 확인
- `test/e2e-stage2.js`: 라우팅 + 자정 넘기기 (Playwright 가짜 시계)
- `test/sql-stage5.js` (003 45개), `test/sql-stage5-cron.js` (004, 실제 pg_cron 1.6 + `test/supabase-stubs.sql`), `test/e2e-stage5-push.js` (Edge Function을 Deno로 띄워 가짜 HTTPS 푸시 서비스로 받고 구독 키로 복호화), `test/e2e-stage5-app.js` (설정·구독·열람/완료 기록)
- Deno: `npm i deno` 후 `DENO_DIR=/var/tmp/denotest/.deno`, 함수 폴더에서 `--node-modules-dir=none`
- `test/e2e-stage4.js`: 매니페스트·서비스 워커·오프라인·업데이트·CDP로 실제 푸시 전달·tag 중복·알림 주소 이동·설치 안내
- 테스트 서버 재시작은 `bash test/start-local.sh` (pkill 패턴이 자기 셸을 죽일 수 있어 직접 pkill 금지)
- `test/e2e-stage3.js`: 체크인 4종 + 복기 (시간대별 가짜 시계, 복기 중 자정 넘김 포함). 서버 RPC가 실제 날짜를 쓰므로 테스트 날짜는 `app_today()` 기준
- 로그인은 이메일+비밀번호 (메일 발송 없음). 실제 로그인 성공은 실제 Supabase Auth에서 확인.

## 진행 단계
1. ✅ 본체 Supabase 연결
2. ✅ 해시 라우팅 + 날짜 변경 처리
3. ✅ 체크인 화면 3종 (`docs/checkin-design.md`) — `#/checkin/morning|midday|evening|evening_final?d=`, `#/review?d=`, `daily_reviews` + `save_daily_review` (002)
4. ✅ PWA + 서비스 워커 — `manifest.webmanifest`, `sw.js` (셸 네트워크 우선 캐시, 푸시 표시, 알림 누름 → 열린 앱에 `steward:open` 메시지)
5. ✅ 알림 배포 완료 (2026-10-08): 003·005·004 실행, `send-checkins` 배포(Verify JWT 끔), 공개키 생성 확인, 예약 `steward-checkins` 매분 실행 중. 설계 `docs/notifications-impl.md`, 순서 `docs/deploy-stage5.md`. 로컬 스택은 `*_cron.sql`을 건너뜀
6. ⏳ 실제 기기 테스트 (휴대폰 알림 켜기 → 실제 도착·누르기 확인)
