// ── 경량 그래디언트 부스팅 트리 (이진 분류, 로지스틱 손실) ─────────
// 외부 의존성 없이 서버 안에서 학습/추론. 분할 이득은 XGBoost와 같은 2차 근사 G²/(H+λ).
// 과적합 방지: 얕은 트리 + 작은 학습률 + 최소 리프 표본 수 + 행 서브샘플링 + L2 정규화
// 결측값(NaN/null): XGBoost처럼 분할마다 "결측은 왼쪽/오른쪽" 중 이득이 큰 쪽을 학습해 저장
//   (미결제약정·롱숏비율은 바이낸스가 최근 30일치만 줘서 오래된 표본은 결측)

export interface TreeNode {
  f: number;   // 분할 feature 인덱스 (-1이면 리프)
  t: number;   // 분할 기준값 (x[f] <= t → l, 아니면 r)
  l: number;
  r: number;
  v: number;   // 리프 값
  m?: number;  // 1 = 결측값은 왼쪽으로 (없거나 0이면 오른쪽)
}

export interface GbdtModel {
  base: number;          // 초기 log-odds
  lr: number;
  trees: TreeNode[][];
  gain: number[];        // feature별 누적 분할 이득 (중요도)
}

export interface GbdtParams {
  trees: number;
  depth: number;
  lr: number;
  minLeaf: number;
  subsample: number;
  lambda: number;
  seed: number;
  colsample?: number;   // 트리마다 쓸 지표 비율 (0~1, 기본 1) — 잡음 많은 지표에 과적합 줄임
}

export const DEFAULT_PARAMS: GbdtParams = { trees: 150, depth: 3, lr: 0.05, minLeaf: 15, subsample: 0.8, lambda: 1, seed: 42 };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const isMissing = (v: unknown) => v === null || v === undefined || Number.isNaN(v as number);

// 재현 가능한 난수 (같은 데이터면 같은 모델)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 트리 1개마다 yield — 동기/비동기(이벤트 루프 양보) 버전이 같은 본체를 씀
// w: 표본 가중치 (생략 시 전부 1). 로지스틱 손실의 1차/2차 미분(g, h)에 곱하는 표준 방식 (XGBoost sample_weight)
function* trainSteps(X: number[][], y: number[], p: GbdtParams, w?: number[]): Generator<void, GbdtModel> {
  const n = X.length;
  const nf = X[0]?.length ?? 0;
  const W = w ?? new Array(n).fill(1);
  const wSum = W.reduce((a, b) => a + b, 0);
  const pos = y.reduce((a, b, i) => a + b * W[i], 0);
  const prior = Math.min(0.99, Math.max(0.01, pos / Math.max(1e-9, wSum)));
  const base = Math.log(prior / (1 - prior));
  const F = new Array(n).fill(base);
  const gain = new Array(nf).fill(0);
  const trees: TreeNode[][] = [];
  const rand = rng(p.seed);

  // feature별 전체 정렬 순서를 한 번만 계산 (결측 제외) → 노드마다 정렬하지 않고 마스크로 걸러 순회: O(n)/노드/feature
  const sorted: Int32Array[] = [];
  for (let f = 0; f < nf; f++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (!isMissing(X[i][f])) idx.push(i);
    idx.sort((a, b) => X[a][f] - X[b][f]);
    sorted.push(Int32Array.from(idx));
  }
  const mask = new Uint8Array(n);
  const g = new Float64Array(n), h = new Float64Array(n);

  for (let it = 0; it < p.trees; it++) {
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(F[i]);
      g[i] = W[i] * (pr - y[i]);
      h[i] = Math.max(1e-6, W[i] * pr * (1 - pr));
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (rand() < p.subsample) rows.push(i);
    if (rows.length < p.minLeaf * 2) { yield; continue; }
    // 이 트리에서 분할 후보로 쓸 지표 (colsample < 1이면 일부만)
    const cs = p.colsample ?? 1;
    let feats: number[] = [];
    for (let f = 0; f < nf; f++) if (cs >= 1 || rand() < cs) feats.push(f);
    if (feats.length === 0) feats = [Math.floor(rand() * nf)];

    const nodes: TreeNode[] = [];
    const build = (idx: number[], depth: number): number => {
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      const id = nodes.length;
      nodes.push({ f: -1, t: 0, l: -1, r: -1, v: -G / (H + p.lambda) });
      if (depth >= p.depth || idx.length < p.minLeaf * 2) return id;

      const parentScore = (G * G) / (H + p.lambda);
      const score = (gl: number, hl: number) => (gl * gl) / (hl + p.lambda) + ((G - gl) ** 2) / (H - hl + p.lambda) - parentScore;
      let best = { gain: 1e-9, f: -1, t: 0, m: 0 };
      for (const i of idx) mask[i] = 1;
      for (const f of feats) {
        let GM = 0, HM = 0, cntM = 0;
        for (const i of idx) if (isMissing(X[i][f])) { GM += g[i]; HM += h[i]; cntM++; }
        const cntN = idx.length - cntM;
        const s = sorted[f];
        let GL = 0, HL = 0, cnt = 0, prev = -1;
        for (let k = 0; k < s.length; k++) {
          const i = s[k];
          if (!mask[i]) continue;
          if (prev >= 0 && X[prev][f] !== X[i][f]) {
            const t = (X[prev][f] + X[i][f]) / 2;
            // 결측 → 오른쪽
            if (cnt >= p.minLeaf && cntN - cnt + cntM >= p.minLeaf) {
              const gn = score(GL, HL);
              if (gn > best.gain) best = { gain: gn, f, t, m: 0 };
            }
            // 결측 → 왼쪽
            if (cntM > 0 && cnt + cntM >= p.minLeaf && cntN - cnt >= p.minLeaf) {
              const gn = score(GL + GM, HL + HM);
              if (gn > best.gain) best = { gain: gn, f, t, m: 1 };
            }
          }
          GL += g[i]; HL += h[i]; cnt++; prev = i;
        }
      }
      for (const i of idx) mask[i] = 0;
      if (best.f < 0) return id;

      gain[best.f] += best.gain;
      const goLeft = (v: number) => (isMissing(v) ? best.m === 1 : v <= best.t);
      const L = idx.filter(i => goLeft(X[i][best.f]));
      const R = idx.filter(i => !goLeft(X[i][best.f]));
      nodes[id].f = best.f;
      nodes[id].t = best.t;
      if (best.m) nodes[id].m = 1;
      nodes[id].l = build(L, depth + 1);
      nodes[id].r = build(R, depth + 1);
      return id;
    };
    build(rows, 0);
    trees.push(nodes);
    for (let i = 0; i < n; i++) F[i] += p.lr * evalTree(nodes, X[i]);
    yield;
  }
  return { base, lr: p.lr, trees, gain };
}

export function trainGbdt(X: number[][], y: number[], p: GbdtParams = DEFAULT_PARAMS, w?: number[]): GbdtModel {
  const it = trainSteps(X, y, p, w);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// 서버에서 학습할 때 사용 — 트리 몇 개마다 이벤트 루프에 양보해 실거래 스캐너·주문 처리가 멈추지 않게 함
export async function trainGbdtAsync(X: number[][], y: number[], p: GbdtParams = DEFAULT_PARAMS, w?: number[]): Promise<GbdtModel> {
  const it = trainSteps(X, y, p, w);
  for (let k = 0; ; k++) {
    const r = it.next();
    if (r.done) return r.value;
    if (k % 5 === 4) await new Promise(res => setImmediate(res));
  }
}

function evalTree(nodes: TreeNode[], x: number[]): number {
  let k = 0;
  while (nodes[k].f >= 0) {
    const nd = nodes[k];
    const v = x[nd.f];
    k = isMissing(v) ? (nd.m ? nd.l : nd.r) : (v <= nd.t ? nd.l : nd.r);
  }
  return nodes[k].v;
}

// 라벨=1일 확률 (0~1)
export function predictGbdt(m: GbdtModel, x: number[]): number {
  let z = m.base;
  for (const t of m.trees) z += m.lr * evalTree(t, x);
  return sigmoid(z);
}

// 트리 앞 k개까지만 쓴 예측을 여러 k에 대해 한 번에 (트리 개수 튜닝용 — 모델 하나로 50/100/200...개 성능 비교)
export function predictStaged(m: GbdtModel, x: number[], ks: number[]): number[] {
  const out: number[] = [];
  let z = m.base, t = 0;
  for (const k of ks) {
    for (; t < Math.min(k, m.trees.length); t++) z += m.lr * evalTree(m.trees[t], x);
    out.push(sigmoid(z));
  }
  return out;
}

// 앞 k개 트리만 남긴 모델
export const truncateModel = (m: GbdtModel, k: number): GbdtModel => ({ ...m, trees: m.trees.slice(0, k) });

// 순위 기반 AUC (0.5 = 무작위, 1 = 완벽)
export function auc(scores: number[], y: number[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0;
  for (let r = 0; r < idx.length; ) {
    let e = r;
    while (e + 1 < idx.length && scores[idx[e + 1]] === scores[idx[r]]) e++;
    const avgRank = (r + e) / 2 + 1;
    for (let k = r; k <= e; k++) if (y[idx[k]] === 1) { rankSum += avgRank; nPos++; }
    r = e + 1;
  }
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}
