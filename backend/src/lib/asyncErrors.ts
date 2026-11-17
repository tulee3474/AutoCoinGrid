// Express 4는 async 라우트 핸들러에서 던진 에러(Promise reject)를 잡지 않음 → unhandledRejection으로
// 서버 프로세스 전체가 죽고 재시작됨(스캐너 재시작 + 캐시 초기화 → 바이낸스 요청 폭주로 이어짐).
// 라우터 레이어를 감싸 async 핸들러의 reject를 next(err)로 넘겨 에러 미들웨어가 500으로 응답하게 함
// (express-async-errors 패키지와 같은 방식). 다른 모든 import보다 먼저 로드해야 함.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req: unknown, res: unknown, next: (err?: unknown) => void) {
  const fn = this.handle;
  if (typeof fn !== 'function' || fn.length > 3) return original.call(this, req, res, next);   // 에러 핸들러는 그대로
  try {
    const ret = fn(req, res, next);
    if (ret && typeof ret.catch === 'function') ret.catch(next);
  } catch (err) {
    next(err);
  }
};

// 라우트 밖(스캐너·스케줄러 등)에서 놓친 비동기 에러도 서버를 죽이지 않고 로그만 남김
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

export {};
