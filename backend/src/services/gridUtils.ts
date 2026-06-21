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
  const finalAvg = sumPrices / count;
  return finalAvg * (1 + step);
}
