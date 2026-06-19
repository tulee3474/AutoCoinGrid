import { useState } from 'react';

function AccordionItem({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 bg-card hover:bg-border/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">{icon}</span>
          <span className="font-semibold text-gray-200 text-sm">{title}</span>
        </div>
        <span className="text-gray-500 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-5 py-4 bg-card border-t border-border text-sm text-gray-300 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

function Step({ num, title, desc }: { num: number; title: string; desc: string }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent/20 text-accent text-xs font-bold flex items-center justify-center">
        {num}
      </div>
      <div>
        <p className="font-medium text-gray-200">{title}</p>
        <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

function Highlight({ children }: { children: React.ReactNode }) {
  return <span className="bg-accent/15 text-accent px-1.5 py-0.5 rounded text-xs font-semibold">{children}</span>;
}

function InfoBox({ type, children }: { type: 'tip' | 'warn' | 'danger'; children: React.ReactNode }) {
  const styles = {
    tip:    'bg-up/10 border-up/30 text-up',
    warn:   'bg-warn/10 border-warn/30 text-warn',
    danger: 'bg-down/10 border-down/30 text-down'
  };
  const icons = { tip: '✓', warn: '⚠', danger: '✕' };
  return (
    <div className={`border rounded-lg p-3 flex gap-2.5 text-xs ${styles[type]}`}>
      <span className="flex-shrink-0 font-bold">{icons[type]}</span>
      <span className="text-gray-300">{children}</span>
    </div>
  );
}

export default function Guide() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="page-title">사용 가이드</h1>
        <p className="page-sub">AutoCoin 전략 개요 및 각 화면 사용법</p>
      </div>

      {/* 전략 한눈에 보기 */}
      <div className="card bg-gradient-to-br from-accent/10 to-card">
        <h2 className="section-title mb-3">이 앱이 하는 것</h2>
        <p className="text-sm text-gray-300 leading-relaxed">
          암호화폐 시장에서 단기 급등("펌핑") 후 하락하는 잡코인을 자동으로 찾아
          <strong className="text-white"> 숏(공매도) + 그리드 전략</strong>으로 수익을 추구합니다.
          과거 데이터 기반 <strong className="text-white">베이지안 승률 계산</strong>으로
          전략 유효성을 검증할 수 있습니다.
        </p>
      </div>

      <AccordionItem icon="💡" title="전략의 핵심 논리">
        <p className="leading-relaxed">
          잡코인이 단기간에 급등(<Highlight>+30% ~ +200%</Highlight>)하면
          대부분 <strong className="text-white">평균 회귀(Mean Reversion)</strong> 현상으로 다시 하락합니다.
          이 구간을 숏(공매도)으로 노립니다.
        </p>
        <div className="bg-surface rounded-lg p-4 font-mono text-xs space-y-1 text-gray-400">
          <p>1. 코인이 +50% 급등 → 과매수 구간</p>
          <p>2. 숏 진입 (예: $100 → $150 구간에서)</p>
          <p>3. 더 오를 경우 대비: $165, $180, $195... 위로 그리드 추가 숏</p>
          <p>4. 가격 하락 시 전체 포지션 익절</p>
        </div>
        <InfoBox type="warn">
          급등 후 추가 상승하는 경우도 있습니다. 그리드 상단의 손절 조건을 반드시 설정하세요.
        </InfoBox>
      </AccordionItem>

      <AccordionItem icon="🗺" title="사용 순서 (권장 플로우)">
        <div className="space-y-4">
          <Step num={1} title="전략 설정 (/strategy)"
            desc="진입 조건(RSI, 24h 상승률, 볼륨 배수 등)과 그리드 파라미터를 설정합니다. 추천 전략을 클릭하면 바로 적용됩니다." />
          <Step num={2} title="승률 검증 → 전략 설정 화면 하단"
            desc="'승률 검증' 버튼을 눌러 상위 알트코인의 과거 데이터로 베이지안 승률을 계산합니다. 기댓값(EV)이 양수일 때만 실전에서 사용하세요." />
          <Step num={3} title="백테스트 (/backtest)"
            desc="특정 코인으로 더 긴 기간의 상세 백테스트를 실행하고 에퀴티 커브를 확인합니다." />
          <Step num={4} title="가상 지갑 (/paper)"
            desc="실제 돈 없이 자동매매를 시뮬레이션합니다. 전략을 켜고 수익/손실 흐름을 먼저 확인하세요." />
        </div>
      </AccordionItem>

      <AccordionItem icon="📊" title="진입 조건 지표 설명">
        <div className="space-y-4">
          <div>
            <p className="font-semibold text-gray-200 mb-1">RSI (상대강도지수)</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              0~100 사이 값. <Highlight>70 이상</Highlight>이면 과매수 구간.
              급등 코인을 노리려면 RSI 70~90 범위를 사용합니다.
              너무 높게 설정하면 신호가 거의 발생하지 않습니다.
            </p>
          </div>
          <div>
            <p className="font-semibold text-gray-200 mb-1">24시간 가격 상승률</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              하루 동안 얼마나 올랐는지. <Highlight>+30% 이상</Highlight>을 기준으로 하면
              유의미한 펌핑 코인만 필터됩니다. 너무 낮게 설정하면 일반 코인도 포함됩니다.
            </p>
          </div>
          <div>
            <p className="font-semibold text-gray-200 mb-1">볼륨 배수</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              현재 거래량 ÷ 20일 평균 거래량. <Highlight>3x 이상</Highlight>이면
              평소보다 3배 이상 거래가 몰린 것. 거짓 신호(소량 펌핑)를 걸러냅니다.
            </p>
          </div>
          <div>
            <p className="font-semibold text-gray-200 mb-1">BTC 도미넌스</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              BTC가 전체 암호화폐 시장에서 차지하는 비중.
              <Highlight>낮을수록</Highlight> 알트코인 장세. 도미넌스가 높으면
              BTC로 자금이 쏠려 알트 숏에 불리할 수 있습니다.
            </p>
          </div>
          <div>
            <p className="font-semibold text-gray-200 mb-1">MA200 위 조건</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              200일 이동평균선 위에 있는 코인만 선정.
              장기 상승 추세에 있는 코인이 단기 펌핑 후 조정받을 가능성이 더 높습니다.
            </p>
          </div>
        </div>
      </AccordionItem>

      <AccordionItem icon="⚡" title="그리드 숏 전략 설명">
        <p className="leading-relaxed text-xs text-gray-400">
          한 번에 모든 물량을 숏 치는 대신, 가격이 더 올라갈 경우를 대비해
          <strong className="text-gray-200"> 위로 갈수록 더 많이 숏을 쌓는</strong> 방식입니다.
        </p>
        <div className="bg-surface rounded-lg p-4 font-mono text-xs space-y-1">
          <p className="text-gray-500">진입가: $100 (레버리지 3x)</p>
          <p className="text-gray-300">레벨 0: $100 → 숏 $100 진입</p>
          <p className="text-gray-300">레벨 1: $110 → 숏 $100 추가 (10% 위)</p>
          <p className="text-gray-300">레벨 2: $120 → 숏 $100 추가</p>
          <p className="text-gray-300">레벨 3: $130 → 숏 $100 추가</p>
          <p className="text-gray-300">레벨 4: $140 → 숏 $100 추가</p>
          <p className="text-warn">손절: $154 이상 (마지막 그리드 위)</p>
          <p className="text-up">익절: 평균 진입가 대비 20% 하락시</p>
        </div>
        <InfoBox type="tip">
          그리드가 많을수록 평균 진입가가 높아져 수익률이 좋아지지만,
          총 노출 금액도 커집니다. 리스크 관리를 위해 손절가를 반드시 설정하세요.
        </InfoBox>
      </AccordionItem>

      <AccordionItem icon="🎲" title="베이지안 승률이란?">
        <p className="text-xs text-gray-400 leading-relaxed">
          단순한 백테스트와 달리, 베이지안 접근은
          <strong className="text-gray-200"> "조건이 충족된 경우만" </strong>
          을 데이터로 삼아 조건부 확률을 계산합니다.
        </p>
        <div className="bg-surface rounded-lg p-4 text-xs font-mono space-y-2">
          <p className="text-gray-400">P(수익 | 조건 충족) = 수익 횟수 / 총 신호 횟수</p>
          <p className="text-gray-400">기댓값 = P(승) × 평균수익 − P(패) × 평균손실</p>
          <p className="text-gray-500 mt-2">예시:</p>
          <p className="text-gray-300">신호 47번 → 수익 31번 → 승률 66%</p>
          <p className="text-gray-300">평균수익 +23% / 평균손실 -12%</p>
          <p className="text-up">기댓값 = 0.66×23 − 0.34×12 = +11.1% / 거래</p>
        </div>
        <InfoBox type="tip">
          기댓값이 양수라도 수수료(약 0.04% × 2회)와 슬리피지를 차감해야 실제 기댓값이 나옵니다.
        </InfoBox>
      </AccordionItem>

      <AccordionItem icon="🔑" title="Binance API 설정 방법">
        <div className="space-y-3">
          <Step num={1} title="Binance 접속 → 프로필 → API Management"
            desc="로그인 후 우측 상단 프로필 → API Management 클릭" />
          <Step num={2} title="새 API 키 생성"
            desc="이름 입력(예: AutoCoin) → API 유형: 시스템 생성 키 선택" />
          <Step num={3} title="권한 설정"
            desc="'선물 거래 활성화' 체크 필수. IP 화이트리스트 추가를 권장합니다." />
          <Step num={4} title="내 정보 → API 키 등록"
            desc="사이트 내 API 키 등록 화면에서 입력하면 암호화되어 서버에 저장됩니다." />
        </div>
        <InfoBox type="danger">
          API 키와 시크릿은 절대 외부에 공유하지 마세요. 출금 권한은 부여하지 않는 것이 안전합니다.
        </InfoBox>
      </AccordionItem>

      <AccordionItem icon="⚠️" title="주의사항 및 리스크">
        <div className="space-y-3">
          <InfoBox type="danger">
            레버리지 거래는 원금 전액 손실(청산) 위험이 있습니다. 잃어도 되는 금액만 사용하세요.
          </InfoBox>
          <InfoBox type="danger">
            잡코인은 예상보다 훨씬 더 오를 수 있습니다(숏 스퀴즈). 손절가 없이 운용하지 마세요.
          </InfoBox>
          <InfoBox type="warn">
            백테스트 결과는 과거 데이터 기반이며 미래 수익을 보장하지 않습니다.
          </InfoBox>
          <InfoBox type="tip">
            처음에는 레버리지 2x, 소액($10~$20)으로 시작해 전략을 충분히 검증한 후 금액을 늘리세요.
          </InfoBox>
        </div>
      </AccordionItem>

      <div className="card text-center py-6 text-gray-500 text-xs">
        AutoCoin은 교육 및 연구 목적 도구입니다. 투자 손실에 대한 책임은 사용자 본인에게 있습니다.
      </div>
    </div>
  );
}
