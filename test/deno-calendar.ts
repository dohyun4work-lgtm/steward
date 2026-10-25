// calendar-today 일정 읽기 검증 (Deno): 구글 캘린더 내보내기와 같은 형식의 iCal로 하루치 일정을 맞게 고르는지
// 실행: 함수 폴더에서 DENO_DIR=/var/tmp/denotest/.deno deno run --allow-net --allow-env --node-modules-dir=none ../../../test/deno-calendar.ts
import { eventsForDay } from '../supabase/functions/calendar-today/index.ts';

const ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:DH
X-WR-TIMEZONE:Asia/Seoul
BEGIN:VTIMEZONE
TZID:Asia/Seoul
X-LIC-LOCATION:Asia/Seoul
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART:20261026T010000Z
DTEND:20261026T020000Z
UID:single-utc@google.com
SUMMARY:교역자 회의
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20260907T140000
DTEND;TZID=Asia/Seoul:20260907T150000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Asia/Seoul:20261102T140000
UID:weekly@google.com
SUMMARY:주간 미디어팀 점검
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261109T160000
DTEND;TZID=Asia/Seoul:20261109T170000
RECURRENCE-ID;TZID=Asia/Seoul:20261109T140000
UID:weekly@google.com
SUMMARY:주간 미디어팀 점검 (시간 변경)
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261027
UID:allday@google.com
SUMMARY:사진팀 선별 마감
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261025
DTEND;VALUE=DATE:20261028
UID:multiday@google.com
SUMMARY:가을 특별새벽기도회
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20000312
DTEND;VALUE=DATE:20000313
RRULE:FREQ=YEARLY
UID:birthday@google.com
SUMMARY:아내 생일
END:VEVENT
BEGIN:VEVENT
DTSTART:20261026T050000Z
DTEND:20261026T060000Z
UID:cancelled@google.com
SUMMARY:취소된 약속
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261025T230000
DTEND;TZID=Asia/Seoul:20261026T013000
UID:overnight@google.com
SUMMARY:밤샘 편집
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261025T200000
DTEND;TZID=America/New_York:20261025T210000
UID:ny@google.com
SUMMARY:미국 통화
END:VEVENT
BEGIN:VEVENT
DTSTART:20261027T010000Z
DTEND:20261027T020000Z
UID:otherday@google.com
SUMMARY:다른 날 일정
END:VEVENT
BEGIN:VEVENT
DTSTART:20261026T120000Z
DTEND:20261026T130000Z
UID:evening@google.com
SUMMARY:
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20250105T070000
DTEND;TZID=Asia/Seoul:20250105T073000
RRULE:FREQ=DAILY;UNTIL=20261020T220000Z
UID:ended@google.com
SUMMARY:끝난 매일 반복
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');

let pass = 0, total = 0;
const check = (name: string, ok: boolean, detail = '') => { total++; if (ok) pass++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const show = (r: { events: { title: string; start: string | null; end: string | null; allDay: boolean }[] }) => r.events.map(e => `${e.allDay ? '종일' : (e.start ?? '…') + '-' + (e.end ?? '…')} ${e.title}`).join(' / ');

// 2026-10-26 (월)
const mon = eventsForDay(ICS, '2026-10-26');
const want = ['종일 가을 특별새벽기도회', '종일 사진팀 선별 마감', '…-01:30 밤샘 편집', '09:00-10:00 미국 통화', '10:00-11:00 교역자 회의', '14:00-15:00 주간 미디어팀 점검', '21:00-22:00 (제목 없음)'];
check('10/26: 종일 → 시간순, 서울 시각으로 변환 (UTC·뉴욕 시간대)', show(mon) === want.join(' / '), show(mon));
check('10/26: 취소된 일정·다른 날 일정·끝난 반복은 빠짐', !show(mon).includes('취소') && !show(mon).includes('다른 날') && !show(mon).includes('끝난'));
check('10/26: 전체 개수', mon.total === 7, String(mon.total));

const sun = eventsForDay(ICS, '2026-10-25');
check('10/25: 여러 날 종일 첫날, 자정 넘는 일정은 시작 시각·끝 없음', show(sun) === '종일 가을 특별새벽기도회 / 23:00-… 밤샘 편집', show(sun));
check('10/27: 여러 날 종일 마지막 날 포함, 10/28은 빠짐', show(eventsForDay(ICS, '2026-10-27')).startsWith('종일 가을 특별새벽기도회') && !show(eventsForDay(ICS, '2026-10-28')).includes('특별새벽'));
check('11/2: 반복에서 뺀 날(EXDATE)은 없음', !show(eventsForDay(ICS, '2026-11-02')).includes('미디어팀'), show(eventsForDay(ICS, '2026-11-02')));
check('11/9: 한 번만 바꾼 반복 일정은 바뀐 시간·제목으로', show(eventsForDay(ICS, '2026-11-09')) === '16:00-17:00 주간 미디어팀 점검 (시간 변경)', show(eventsForDay(ICS, '2026-11-09')));
check('11/16: 다시 원래 반복', show(eventsForDay(ICS, '2026-11-16')) === '14:00-15:00 주간 미디어팀 점검');
check('3/12: 매년 반복 종일 (오래된 시작)', show(eventsForDay(ICS, '2027-03-12')) === '종일 아내 생일', show(eventsForDay(ICS, '2027-03-12')));
check('10/20: 끝나기 전 매일 반복은 보임', show(eventsForDay(ICS, '2026-10-20')).includes('07:00-07:30 끝난 매일 반복'));
check('일정 없는 날은 빈 목록', eventsForDay(ICS, '2026-12-25').events.length === 0);
let threw = false; try { eventsForDay('not a calendar', '2026-10-26'); } catch (_) { threw = true; }
check('형식이 틀리면 오류', threw);
const t0 = performance.now(); eventsForDay(ICS, '2030-06-03'); const ms = performance.now() - t0;
check('먼 미래 날짜도 빠르게 (반복 펼치기 제한)', ms < 1500, `${Math.round(ms)}ms`);

console.log(`\n${pass} / ${total} 통과`);
Deno.exit(pass === total ? 0 : 1);
