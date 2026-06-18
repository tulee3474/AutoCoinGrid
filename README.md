# AutoCoin

잡코인 급등 후 숏 그리드 자동매매 웹앱. Binance API 기반, 가상 지갑으로 전략 검증 가능.

---

## 실행 방법

```bash
# 백엔드 (터미널 1)
cd backend
npm install
cp .env.example .env   # Binance API 키 입력 (가상 지갑은 키 없이도 사용 가능)
npm run dev            # http://localhost:3001

# 프론트엔드 (터미널 2)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

---

## 전략 개요

1. **스캔** — RSI, 24h 상승률, 볼륨 배수, BTC 도미넌스 조건을 모두 충족하는 코인 탐색
2. **진입** — 조건 충족 시 숏 포지션 진입 (2~5x 레버리지)
3. **그리드** — 진입가 위로 X% 간격마다 추가 숏 주문 배치
4. **청산** — 익절(하락 목표%), 손절(상승 한도%), 시간 초과 중 먼저 도달한 조건

---

## 전체 구조

```
AutoCoin/
├── backend/    Node.js + Express + TypeScript  (포트 3001)
│   └── data/   JSON/CSV 영구 저장소
└── frontend/   React + Vite + Tailwind         (포트 5173)
```

요청 흐름: **브라우저 → Vite 프록시(`/api/*`) → 백엔드(3001) → Binance / CoinGecko API**

---

## 백엔드 구조

```
backend/
├── .env                        Binance API 키, 포트 설정
├── data/
│   ├── strategies.json         저장된 전략 목록 (자동 생성)
│   ├── paper_wallet.json       가상 지갑 잔고 및 포지션 (자동 생성)
│   └── btc_dominance.csv       BTC 도미넌스 역사 데이터 (수동 업로드 또는 자동 수집)
│
└── src/
    ├── index.ts                서버 진입점 (Express + WebSocket + 자동 스캐너 시작)
    ├── types.ts                공유 타입 정의
    │
    ├── services/
    │   ├── binance.ts          Binance REST API 래퍼 (퍼블릭 + 서명 요청)
    │   ├── indicator.ts        기술 지표 계산 (RSI, SMA, EMA, 볼륨배수)
    │   ├── backtest.ts         백테스트 엔진 (조건 체크 → 트레이드 시뮬레이션)
    │   ├── scanner.ts          조건 기반 코인 스캔
    │   ├── paperWallet.ts      가상 지갑 상태 관리 (잔고, 포지션, 거래 로그)
    │   ├── autoScanner.ts      1분마다 시장 스캔 → 자동 가상 매매 실행
    │   └── btcDominanceHistory.ts  BTC 도미넌스 CSV 로드/저장/CoinGecko 수집
    │
    └── routes/
        ├── market.ts           GET  /api/market/tickers|klines|indicators|scan|dominance
        ├── strategy.ts         CRUD /api/strategy
        ├── backtest.ts         POST /api/backtest/run|validate|multi
        ├── trading.ts          GET|POST|DELETE /api/trading/positions|orders|short|account
        ├── paper.ts            GET|POST|DELETE /api/paper/*  (가상 지갑 전체)
        └── data.ts             GET|POST|DELETE /api/data/btc-dominance*
```

---

## 프론트엔드 구조

```
frontend/src/
├── main.tsx              React 앱 시작점
├── App.tsx               라우터 (URL ↔ 페이지 컴포넌트 매핑)
├── index.css             Tailwind 기본 + 공통 컴포넌트 스타일
├── types.ts              타입 정의 (backend/types.ts와 동기화 유지)
├── store.ts              전역 상태 (Zustand) — topTickers, 전략 조건 등
│
├── utils/
│   └── api.ts            백엔드 API 호출 함수 모음 (axios 기반)
│
└── components/
    ├── Layout.tsx         사이드바 + 전체 레이아웃
    ├── Dashboard.tsx      /dashboard  — 시장 현황, 급등 코인, BTC 도미넌스
    ├── Scanner.tsx        /scanner    — 조건 스캔 실행, 결과 테이블
    ├── Strategy.tsx       /strategy   — 전략 조건 설정, 코인별 백테스트 모달
    ├── Backtest.tsx       /backtest   — 백테스트 실행, 에퀴티 커브, 기댓값
    ├── PaperTrading.tsx   /paper      — 가상 지갑, 포지션, 스캐너, 전략 관리
    ├── Positions.tsx      /positions  — 실제 Binance 포지션 모니터링
    └── Guide.tsx          /guide      — 사용법 + BTC 도미넌스 데이터 관리
```

---

## 페이지별 기능

### 대시보드 (`/dashboard`)
- 상위 거래량 코인 실시간 시세 (topTickers → Backtest 공유)
- BTC 도미넌스 현재값
- 전략 조건 요약 카드

### 스캐너 (`/scanner`)
- 설정된 전략 조건으로 전체 USDT 페어 스캔
- 조건 충족 코인 목록 (RSI, 상승률, 볼륨 점수)

### 전략 설정 (`/strategy`)
- RSI, 24h 상승률, 볼륨 배수, BTC 도미넌스 조건 슬라이더
- 그리드 파라미터 (레버리지, 간격, TP/SL, 시간 제한)
- 전략 저장 / 목록 관리
- 전략 검증(Validate): Binance USDT 전체 페어에서 베이지안 승률 계산
- 코인별 클릭 → 상세 백테스트 모달 (1500봉)

### 백테스트 (`/backtest`)
- 단일 코인 상세 백테스트 (기본 1500봉)
- 대시보드 상위 코인 빠른 선택 (24h 변동률 표시)
- 타임프레임: 15m / 30m / 1h / 4h / 1d (★ 현재 전략 설정 표시)
- 에퀴티 커브, 개별 트레이드 목록

### 가상 지갑 (`/paper`)
- 초기 잔고 $10,000 USDT, 실제 API 연결 불필요
- 1분마다 자동 스캔 → 조건 충족 시 가상 포지션 자동 진입
- 실시간 PnL, 승률, 실현/미실현 손익 요약 (StatCard 4개)
- 오픈 포지션: TP/SL/만료일 표시, 수동 청산 가능
- 전략 목록: 활성화 토글, 수정 링크, 삭제
- 거래 로그 / 스캔 로그 (터미널 스타일)
- 지갑 초기화 버튼

### 실제 포지션 (`/positions`)
- Binance Futures 실제 계좌 연결 필요
- 5초 폴링으로 포지션 자동 갱신
- API 키 미설정 시: 설정 안내 + 가상 지갑 링크

### 가이드 (`/guide`)
- 전략 설정 방법, 백테스트 해석, 주의사항 아코디언
- **BTC 도미넌스 역사 데이터 관리**:
  - CoinGecko 자동 수집 (365일 / 730일 버튼)
  - 수동 CSV 업로드 (`date,dominance` 형식)
  - 현재 데이터 범위 표시, 삭제 버튼

---

## API 엔드포인트

### 마켓 (`/api/market`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/tickers` | 상위 거래량 USDT 페어 목록 |
| GET | `/klines/:symbol` | 캔들 데이터 |
| GET | `/indicators/:symbol` | RSI, 볼륨배수 등 계산된 지표 |
| POST | `/scan` | 조건 기반 전체 시장 스캔 |
| GET | `/dominance` | 현재 BTC 도미넌스 |

### 전략 (`/api/strategy`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/` | 전체 전략 목록 |
| POST | `/` | 새 전략 저장 |
| PUT | `/:id` | 전략 수정 |
| DELETE | `/:id` | 전략 삭제 |
| POST | `/:id/toggle` | 활성화 토글 |

### 백테스트 (`/api/backtest`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/run` | 단일 코인 백테스트 |
| POST | `/validate` | 전체 페어 멀티 백테스트 (승률 검증) |
| POST | `/multi` | 복수 코인 멀티 백테스트 |

### 실제 거래 (`/api/trading`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/account` | 계좌 잔고 |
| GET | `/positions` | 오픈 포지션 목록 |
| POST | `/short` | 그리드 숏 진입 |
| DELETE | `/position/:symbol` | 포지션 청산 |

### 가상 지갑 (`/api/paper`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/wallet` | 잔고, 에퀴티, 승률 |
| GET | `/positions` | 오픈 포지션 (실시간 PnL 포함) |
| GET | `/logs?limit=50` | 거래 로그 |
| POST | `/reset` | 지갑 초기화 ($10,000 복구) |
| DELETE | `/positions/:id` | 포지션 수동 청산 |
| GET | `/scanner/status` | 스캐너 상태 및 최근 로그 |
| POST | `/scanner/start` | 스캐너 시작 |
| POST | `/scanner/stop` | 스캐너 중지 |

### BTC 도미넌스 데이터 (`/api/data`)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/btc-dominance` | 데이터 현황 (보유 기간, 건수) |
| GET | `/btc-dominance/raw` | CSV 원본 텍스트 |
| POST | `/btc-dominance` | CSV 업로드 (`{ csv: string }`) |
| POST | `/btc-dominance/fetch?days=365` | CoinGecko에서 자동 수집 |
| DELETE | `/btc-dominance` | 데이터 삭제 |

---

## BTC 도미넌스 역사 데이터

백테스트 시 각 캔들 시점의 실제 BTC 도미넌스를 조회해 조건 적용.  
데이터 없으면 해당 캔들은 조건 건너뜀(skip) — 결과가 왜곡되지 않음.

**CSV 형식 (여러 포맷 자동 파싱):**
```csv
date,dominance
2024-01-15,52.34
2024-01-16,53.10
```

지원 날짜 포맷: `YYYY-MM-DD`, `MM/DD/YYYY`, `"Jan 15, 2024"`

**CoinGecko 자동 수집:**
- 가이드 페이지 → "BTC 도미넌스 역사 데이터 관리" 섹션
- "CoinGecko에서 수집" 버튼 클릭 (무료, 키 불필요)
- 한도 초과(429) 시 수동 CSV 업로드 사용

---

## 가상 지갑 사용법

1. 전략 설정 페이지에서 전략 저장 (활성화 상태로)
2. 가상 지갑 페이지 접속 → 스캐너 시작
3. 1분마다 자동 스캔 — 조건 충족 코인이 있으면 자동 진입
4. 포지션이 TP/SL/시간 초과에 도달하면 자동 청산
5. 거래 로그, 스캔 로그로 동작 확인
6. 초기화 버튼으로 $10,000 재시작

> 노트북을 켜 둔 상태에서 백엔드 서버가 실행 중이면 스캐너가 계속 작동합니다.

---

## WebSocket (`ws://localhost:3001/ws`)

서버 → 클라이언트로 브로드캐스트하는 이벤트:

| `type` | 발생 시점 |
|--------|-----------|
| `connected` | 최초 연결 |
| `positions` | 5초마다 (Binance API 키 있을 때) |
| `paper_signal` | 스캐너가 가상 포지션 진입 시 |
| `paper_close` | TP/SL/타임아웃으로 가상 청산 시 |
| `paper_scan` | 1분마다 스캔 완료 시 |

---

## 환경변수 (`backend/.env`)

| 키 | 설명 |
|----|------|
| `PORT` | 백엔드 포트 (기본 3001) |
| `BINANCE_API_KEY` | Binance API 키 (Futures 읽기+거래 권한) |
| `BINANCE_API_SECRET` | Binance API 시크릿 |
| `USE_TESTNET` | `true` 시 Binance 테스트넷 사용 |

API 키 없이도 시세 조회, 스캐너, 백테스트, **가상 지갑** 전부 사용 가능.  
실제 주문/포지션 조회는 API 키 필요.

---

## API 비용

| API | 용도 | 비용 |
|-----|------|------|
| Binance Spot REST (`api.binance.com`) | 시세, 캔들, 스캔 | **무료** (공개 엔드포인트) |
| Binance Futures REST (`fapi.binance.com`) | 실제 포지션/주문 | **무료** (읽기), 거래 시 수수료 |
| Binance 거래 수수료 | 실제 Futures 진입/청산 | 0.02~0.05% per side (BNB 할인 가능) |
| CoinGecko 공개 API | BTC 도미넌스 역사 데이터 수집 | **무료** (분당 30회 한도) |
| 가상 지갑 스캐너 | 1분마다 자동 매매 | **무료** (내부 계산) |

**Binance API 웨이트 소비 예시:**
- `GET /fapi/v1/ticker/24hr` (전체 페어): 웨이트 40
- `GET /api/v3/klines?limit=1500`: 웨이트 10
- 분당 한도: 1200 웨이트 — 전략 검증(200개 코인 × 10) = 2000 → 40개씩 배치 + 300ms 딜레이로 분산

---

## 수정 포인트 요약

| 수정할 것 | 파일 |
|-----------|------|
| 진입 조건 로직 | `backend/src/services/backtest.ts` → `checkConditions()` |
| 지표 추가 (MACD 등) | `backend/src/services/indicator.ts` + `types.ts` |
| 실제 그리드 주문 | `backend/src/routes/trading.ts` → `POST /short` |
| 가상 지갑 PnL 계산 | `backend/src/services/paperWallet.ts` → `closePaperPosition()` |
| 스캐너 진입 기준 | `backend/src/services/autoScanner.ts` → `signalScore >= 100` 조건 |
| BTC 도미넌스 소스 | `backend/src/routes/market.ts` → `GET /dominance` |
| 사이드바 메뉴 | `frontend/src/components/Layout.tsx` → `NAV` 배열 |
| 전역 상태 추가 | `frontend/src/store.ts` → `AppState` + `create()` |
| API 호출 함수 | `frontend/src/utils/api.ts` |
