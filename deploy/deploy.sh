#!/bin/bash
# 배포 스크립트 — EC2에서 실행
# 사용: cd /home/ubuntu/autocoin && ./deploy/deploy.sh
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "=== AutoCoin 배포 시작 ==="

# 1. 최신 코드 pull
echo "[1/4] 코드 업데이트..."
git pull origin main

# 2. Docker 이미지 빌드
echo "[2/4] Docker 이미지 빌드..."
docker build -t autocoin-backend:latest ./backend
docker build -t autocoin-frontend:latest ./frontend

# 3. .env 파일 존재 확인
if [ ! -f "./backend/.env" ]; then
  echo "오류: backend/.env 파일이 없습니다."
  echo "  cp backend/.env.example backend/.env 후 값을 채워주세요."
  exit 1
fi

# 4. 컨테이너 재시작
echo "[3/4] 컨테이너 재시작..."
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d

# 5. 헬스 체크
echo "[4/4] 헬스 체크 (10초 대기)..."
sleep 10
if curl -sf http://localhost:3001/api/health > /dev/null; then
  echo "✅ 배포 완료 — 백엔드 정상 응답"
else
  echo "⚠️  백엔드 응답 없음 — 로그 확인: docker compose -f docker-compose.prod.yml logs backend"
  exit 1
fi

echo ""
echo "=== 배포 완료 ==="
echo "접속 주소: http://$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo 'EC2-PUBLIC-IP')"
