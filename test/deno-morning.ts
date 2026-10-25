// 아침 알림 문구 검증 (Deno): 오늘 일정 한 줄 + 업무 제목
import { buildPayload, calendarLine } from '../supabase/functions/send-checkins/index.ts';

let pass = 0, total = 0;
const check = (name: string, ok: boolean, detail = '') => { total++; if (ok) pass++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const ev = (title: string, start: string | null, allDay = false) => ({ title, start, end: null, allDay });
const evs = [ev('사진팀 선별 마감', null, true), ev('새벽기도', '05:30'), ev('교역자 회의', '10:00'), ev('셀리더 모임', '19:30')];

check('지금(09:00) 이후 첫 일정', calendarLine(evs, 4, '09:00') === '오늘 일정 4개 · 10:00 교역자 회의', String(calendarLine(evs, 4, '09:00')));
check('남은 시간 일정이 없으면 종일 일정', calendarLine(evs, 4, '20:00') === '오늘 일정 4개 · 사진팀 선별 마감');
check('종일만 없으면 첫 일정', calendarLine([ev('새벽기도', '05:30')], 1, '09:00') === '오늘 일정 1개 · 05:30 새벽기도');
check('일정이 없으면 줄 없음', calendarLine([], 0, '09:00') === null);
check('긴 제목은 줄임', calendarLine([ev('2026 가을 특별새벽기도회 영상 자막 최종 확인 및 업로드', '10:00')], 1, '09:00') === '오늘 일정 1개 · 10:00 2026 가을 특별새벽기도회 영상 자막 최…');

const log = (kind: string) => ({ log_id: 'id', user_id: 'u', kind, local_date: '2026-10-26' });
const s = { overdue: 1, remaining: 5, done: 0, followup: 0 };
const items = [{ title: '주보 원고', overdue: true }, { title: '설교 영상 업로드', overdue: false }];
const body = buildPayload(log('morning'), s, items, '오늘 일정 4개 · 10:00 교역자 회의').body;
check('아침: 개수 → 일정 → 업무 제목 순서', body === '오늘 할 일 5개 · 기한 초과 1\n오늘 일정 4개 · 10:00 교역자 회의\n· 주보 원고 (기한 지남)\n· 설교 영상 업로드\n외 3개', body);
check('캘린더 없으면 예전 문구 그대로', buildPayload(log('morning'), s, items).body === '오늘 할 일 5개 · 기한 초과 1\n· 주보 원고 (기한 지남)\n· 설교 영상 업로드\n외 3개');
check('복기는 개수만', buildPayload(log('review'), { ...s, done: 7 }, items, null).body === '오늘 완료 7개 · 하루를 1분만 돌아봐요');

console.log(`\n${pass} / ${total} 통과`);
Deno.exit(pass === total ? 0 : 1);
