import crypto from 'crypto';
import { FEATURE_NAMES } from './features';

// 학습 데이터·판정 기록이 "지금 모델과 같은 기준"인지 확인하는 버전 값 (trainer·filter 공용)
// 입력값 정의 버전 — FEATURE_NAMES가 바뀌면 달라짐
export const FEATURE_VER = crypto.createHash('sha1').update(FEATURE_NAMES.join(',')).digest('hex').slice(0, 12);

// 전략 설정(진입 조건·매매 설정·방향) 해시 — 바뀌면 백테스트 결과(라벨)가 달라지므로 다른 데이터로 취급
export function strategyHash(s: { conditions: unknown; trade: unknown; side: string }): string {
  return crypto.createHash('sha1').update(JSON.stringify([s.conditions, s.trade, s.side])).digest('hex').slice(0, 16);
}
