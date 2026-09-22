#!/bin/bash
# 배포 스크립트 — EC2에서 실행
# 사용: cd /home/ubuntu/autocoin && ./deploy/deploy.sh
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "=== AutoCoin 배포 시작 ==="

# 루트 볼륨이 작아(6.7GB) 이미지 빌드 도중 디스크가 꽉 차서 실패하는 경우가 잦았음 —
# 빌드 전/백엔드-프론트엔드 사이/끝, 이렇게 세 지점에서 안 쓰는 이미지·빌드캐시를 정리
# (볼륨은 절대 안 건드림 — mysql_data 등 데이터 안전). 근본 해결책은 EBS 볼륨 자체를
# 늘리는 것 — 이건 그 전까지의 임시 방편.
cleanup_disk() {
  docker system prune -a -f > /dev/null
  echo "   디스크 여유: $(df -h / | awk 'NR==2 {print $4}')"
}

# 0. 빌드 전 정리 — 이전 배포에서 남은 dangling 이미지 미리 치움
echo "[0/4] 빌드 전 디스크 정리..."
cleanup_disk

# 1. 최신 코드 pull
echo "[1/4] 코드 업데이트..."
git pull origin main

# 2. Docker 이미지 빌드 (백엔드 빌드가 만든 dangling 이미지를 프론트엔드 빌드 전에 한 번 더 정리 —
# ENOSPC로 실패하던 지점이 정확히 여기였음)
echo "[2/4] Docker 이미지 빌드..."
docker build -t autocoin-backend:latest ./backend
echo "   백엔드 빌드 후 중간 정리..."
cleanup_disk
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

# 6. 배포 후 정리 — 새 컨테이너가 이미 새 이미지로 떠있으니 방금 밀려난 옛 이미지는 안전하게 정리
echo "[+] 배포 후 디스크 정리..."
cleanup_disk

echo ""
echo "=== 배포 완료 ==="
echo "접속 주소: http://$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo 'EC2-PUBLIC-IP')"
