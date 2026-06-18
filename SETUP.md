# AutoCoin 설정 가이드

## 구조

```
AutoCoin/
├── frontend/   React + Vite + Tailwind
└── backend/    Node.js + Express + TypeScript
```

## 설치 및 실행

```bash
# 1. 의존성 설치
cd backend && npm install
cd ../frontend && npm install

# 2. 환경변수 설정
cd ../backend
cp .env.example .env
# .env 파일에 Binance API 키 입력

# 3. 개발 서버 실행 (터미널 2개)
# 터미널 1 (백엔드)
cd backend && npm run dev

# 터미널 2 (프론트엔드)
cd frontend && npm run dev

# 브라우저: http://localhost:5173
```

## Binance API 키 설정

1. Binance → 프로필 → API Management
2. 새 API 키 생성 (이름: AutoCoin)
3. **Futures** 권한 체크 (읽기 + 거래)
4. IP 화이트리스트 설정 권장
5. backend/.env에 복사

## 주의사항

- **테스트넷 먼저**: .env에 `USE_TESTNET=true` 설정 후 테스트
- **소액 테스트**: 실거래 전 소액으로 전략 검증
- **백테스트 필수**: 전략 조건 변경 시 반드시 백테스트 실행
- **청산 주의**: 레버리지 거래는 청산 위험 있음
