/**
 * PDF 방식 그리드 공식
 * nextGrid = currentArithmeticAvgEntry × (1 + gridSpacing/100 / leverage)
 *
 * 추가금이 동일(100 USDT)하고 매수가격이 달라도 PDF 표는 산술평균 기준임
 * (표 직접 검증: leverage=3, step=0.24)
 *   행2: 1×1.24=1.24, avg=(1+1.24)/2=1.12 ✓
 *   행3: 1.12×1.24=1.3888, avg=(1+1.24+1.3888)/3=1.2096 ✓
 */

export function calcPdfGridPrices(
  entryPrice: number,
  leverage: number,
  gridLevels: number,
  gridSpacing: number
): number[] {
  const step = gridSpacing / 100 / leverage;
  const prices: number[] = [];
  let sumPrices = entryPrice;
  let count = 1;

  for (let i = 0; i < gridLevels; i++) {
    const currentAvg = sumPrices / count;        // 산술평균
    const nextPrice  = currentAvg * (1 + step);
    prices.push(nextPrice);
    sumPrices += nextPrice;
    count++;
  }
  return prices;
}

export function calcPdfAvgEntry(entryPrice: number, filledGridPrices: number[]): number {
  const all = [entryPrice, ...filledGridPrices];
  return all.reduce((a, b) => a + b, 0) / all.length;  // 산술평균
}

/**
 * ISOLATED 마진 숏 포지션의 실제 청산가 (Binance 공식 유도)
 * 청산 조건: WB + UPNL(=Q×(E-P)) = 유지증거금(=Q×P×MMR - cum)
 * → P = (WB + Q×E + cum) / (Q×(1+MMR))
 *
 * WB: 이 포지션에 물린 총 증거금(USDT, totalEntryUsdt) — 격리마진 = notional/leverage 가정과 동일
 * Q : 포지션 수량, E: 평균 진입가, mmr: 유지증거금률(소수, 예 0.01=1%), maintAmt: 유지증거금 구간 보정값(cum)
 */
export function calcIsolatedLiquidationPrice(
  marginUsdt: number,
  qty: number,
  avgEntryPrice: number,
  mmr: number,
  maintAmt: number
): number {
  if (qty <= 0) return Infinity;
  return (marginUsdt + qty * avgEntryPrice + maintAmt) / (qty * (1 + mmr));
}

/** 모든 그리드 체결 후 산술평균 진입가에서 한 단계 더 오르면 SL */
export function calcPdfStopLoss(
  entryPrice: number,
  leverage: number,
  gridLevels: number,
  gridSpacing: number
): number {
  const step = gridSpacing / 100 / leverage;
  let sumPrices = entryPrice;
  let count = 1;

  for (let i = 0; i < gridLevels; i++) {
    const currentAvg = sumPrices / count;
    const nextPrice  = currentAvg * (1 + step);
    sumPrices += nextPrice;
    count++;
  }
  const pdfSL = (sumPrices / count) * (1 + step);
  // 격리 마진(ISOLATED) 기준 최대 손실 99%로 제한: 진입가 × (1 + 0.99/레버리지)
  const isolatedSL = entryPrice * (1 + 0.99 / leverage);
  return Math.min(pdfSL, isolatedSL);
}

/**
 * 청산가(실제 또는 추정)까지 거리의 safetyPct% 지점으로 손절가를 캡.
 * 우리 SL 계산식(펀딩비/수수료/실제 유지증거금률 미반영)이 실제 청산가보다 낙관적일 수 있어
 * live/paper/backtest 전부 진입 시 + 그리드 체결 후 재계산 시 공통으로 사용
 */
export function capSlWithLiquidation(
  slPrice: number,
  avgEntry: number,
  liquidationPrice: number,
  safetyPct = 99
): number {
  if (!liquidationPrice || liquidationPrice <= avgEntry) return slPrice;
  const safeCap = avgEntry + (liquidationPrice - avgEntry) * (safetyPct / 100);
  return Math.min(slPrice, safeCap);
}

/**
 * 청산가까지 거리의 safetyPct% 안에 드는 그리드 레벨만 남기고 자름 —
 * 그 너머 레벨은 손절이 먼저 발동해 채워질 기회가 없으므로 애초에 등록하지 않음
 */
export function truncateGridsToSafeZone(
  gridPrices: number[],
  avgEntry: number,
  liquidationPrice: number,
  safetyPct = 99
): number[] {
  if (!liquidationPrice || liquidationPrice <= avgEntry) return gridPrices;
  const safeCap = avgEntry + (liquidationPrice - avgEntry) * (safetyPct / 100);
  const idx = gridPrices.findIndex(p => p >= safeCap);
  return idx === -1 ? gridPrices : gridPrices.slice(0, idx);
}
