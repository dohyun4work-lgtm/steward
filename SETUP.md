# Steward — Supabase 설정 순서

DH 님이 직접 할 일. 순서대로 한 번만 하면 됩니다.

## 1. 프로젝트 만들기
1. supabase.com → New project
2. 이름: `dh-task-hub`, 리전: **Northeast Asia (Seoul)**
3. 데이터베이스 비밀번호는 비밀번호 관리자에 저장 (앱에는 쓰지 않음)

## 2. 스키마 실행
1. 왼쪽 메뉴 **SQL Editor** → New query
2. `supabase/migrations/001_init.sql` 전체 내용을 붙여넣고 **Run**
3. "Success. No rows returned"가 나오면 완료

## 3. 로그인 설정 (이메일 + 비밀번호)
1. **Authentication → Users → Add user → Create new user**
   - 본인 이메일 + 비밀번호 입력 (12자 이상, 다른 곳에서 쓰지 않는 것)
   - **"Auto Confirm User" 체크** (확인 메일 없이 바로 사용)
2. **Authentication → Sign In / Providers → Email**
   - Email 로그인: 켜기
   - **Allow new users to sign up: 끄기** (본인 외 가입 차단)
3. 메일 템플릿·SMTP 설정은 **필요 없음** (메일을 보내지 않는 방식)

## 4. 앱에 연결
1. **Project Settings → API** (또는 Data API)에서 복사
   - Project URL
   - anon / publishable key (공개용)
2. `config.js`에 붙여넣기
   ```js
   window.TASKHUB_CONFIG = {
     supabaseUrl: 'https://xxxx.supabase.co',
     supabaseAnonKey: 'eyJ...',
   };
   ```
3. **service_role / secret 키는 어디에도 넣지 않기** (앱, GitHub, AI 모두)

## 5. 확인
- 앱 열기 → 이메일·비밀번호 입력 → 빈 TODAY 화면
- 업무 하나 추가 → Supabase **Table Editor → tasks**에 행이 생기면 연결 완료

## 참고
- 로그인은 기기마다 한 번만 하면 유지됨.
- 비밀번호를 잊으면 Supabase 대시보드 → Authentication → Users에서 직접 변경.
