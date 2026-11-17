// ── 경량 그래디언트 부스팅 트리 (이진 분류, 로지스틱 손실) ─────────
// 외부 의존성 없이 서버 안에서 학습/추론. 데이터가 수백~수천 건이라 정확 분할(정렬 기반)로 충분히 빠름.
// 과적합 방지: 얕은 트리(depth 3) + 작은 학습률 + 최소 리프 표본 수 + 행 서브샘플링 + L2 정규화

export interface TreeNode {
  f: number;   // 분할 feature 인덱스 (-1이면 리프)
  t: number;   // 분할 기준값 (x[f] <= t → l, 아니면 r)
  l: number;
  r: number;
  v: number;   // 리프 값
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
}

export const DEFAULT_PARAMS: GbdtParams = { trees: 150, depth: 3, lr: 0.05, minLeaf: 15, subsample: 0.8, lambda: 1, seed: 42 };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// 재현 가능한 난수 (같은 데이터면 같은 모델)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function trainGbdt(X: number[][], y: number[], p: GbdtParams = DEFAULT_PARAMS): GbdtModel {
  const n = X.length;
  const nf = X[0]?.length ?? 0;
  const pos = y.reduce((a, b) => a + b, 0);
  const prior = Math.min(0.99, Math.max(0.01, pos / Math.max(1, n)));
  const base = Math.log(prior / (1 - prior));
  const F = new Array(n).fill(base);
  const gain = new Array(nf).fill(0);
  const trees: TreeNode[][] = [];
  const rand = rng(p.seed);

  for (let it = 0; it < p.trees; it++) {
    const g = new Array(n), h = new Array(n);
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(F[i]);
      g[i] = pr - y[i];
      h[i] = Math.max(1e-6, pr * (1 - pr));
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (rand() < p.subsample) rows.push(i);
    if (rows.length < p.minLeaf * 2) continue;

    const nodes: TreeNode[] = [];
    const build = (idx: number[], depth: number): number => {
      const G = idx.reduce((a, i) => a + g[i], 0);
      const H = idx.reduce((a, i) => a + h[i], 0);
      const id = nodes.length;
      nodes.push({ f: -1, t: 0, l: -1, r: -1, v: -G / (H + p.lambda) });
      if (depth >= p.depth || idx.length < p.minLeaf * 2) return id;

      const parentScore = (G * G) / (H + p.lambda);
      let best = { gain: 1e-9, f: -1, t: 0 };
      for (let f = 0; f < nf; f++) {
        const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f]);
        let GL = 0, HL = 0;
        for (let k = 0; k < sorted.length - 1; k++) {
          const i = sorted[k];
          GL += g[i]; HL += h[i];
          const cnt = k + 1;
          if (cnt < p.minLeaf || sorted.length - cnt < p.minLeaf) continue;
          const xv = X[i][f], xn = X[sorted[k + 1]][f];
          if (xv === xn) continue;   // 같은 값 사이에선 분할 불가
          const GR = G - GL, HR = H - HL;
          const gn = (GL * GL) / (HL + p.lambda) + (GR * GR) / (HR + p.lambda) - parentScore;
          if (gn > best.gain) best = { gain: gn, f, t: (xv + xn) / 2 };
        }
      }
      if (best.f < 0) return id;

      gain[best.f] += best.gain;
      const L = idx.filter(i => X[i][best.f] <= best.t);
      const R = idx.filter(i => X[i][best.f] >  best.t);
      nodes[id].f = best.f;
      nodes[id].t = best.t;
      nodes[id].l = build(L, depth + 1);
      nodes[id].r = build(R, depth + 1);
      return id;
    };
    build(rows, 0);
    trees.push(nodes);
    for (let i = 0; i < n; i++) F[i] += p.lr * evalTree(nodes, X[i]);
  }
  return { base, lr: p.lr, trees, gain };
}

function evalTree(nodes: TreeNode[], x: number[]): number {
  let k = 0;
  while (nodes[k].f >= 0) k = x[nodes[k].f] <= nodes[k].t ? nodes[k].l : nodes[k].r;
  return nodes[k].v;
}

// 순손익 플러스로 끝날 확률 (0~1)
export function predictGbdt(m: GbdtModel, x: number[]): number {
  let z = m.base;
  for (const t of m.trees) z += m.lr * evalTree(t, x);
  return sigmoid(z);
}

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
