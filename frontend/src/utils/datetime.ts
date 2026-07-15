// 프로젝트 전체 날짜/시간 표시 공통 포맷 — 뷰어의 로컬 시간대와 무관하게 항상 한국시간(UTC+9),
// 24시간제(오전/오후 없이)로 통일
const KST_TZ = 'Asia/Seoul';

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: KST_TZ,
};
const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: KST_TZ,
};
const DATETIME_OPTS: Intl.DateTimeFormatOptions = { ...DATE_OPTS, ...TIME_OPTS };

export const fmtDate = (ts: string | number | Date) =>
  new Date(ts).toLocaleDateString('ko-KR', DATE_OPTS);

export const fmtTime = (ts: string | number | Date) =>
  new Date(ts).toLocaleTimeString('ko-KR', TIME_OPTS);

export const fmtDateTime = (ts: string | number | Date) =>
  new Date(ts).toLocaleString('ko-KR', DATETIME_OPTS);
