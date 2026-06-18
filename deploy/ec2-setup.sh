#!/bin/bash
# EC2 초기 세팅 스크립트 (Ubuntu 22.04 기준)
# 사용: chmod +x ec2-setup.sh && sudo ./ec2-setup.sh
set -e

echo "=== AutoCoin EC2 초기 세팅 ==="

# 1. 패키지 업데이트
apt-get update -y
apt-get upgrade -y

# 2. Docker 설치
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3. ubuntu 유저를 docker 그룹에 추가 (sudo 없이 docker 사용)
usermod -aG docker ubuntu

# 4. Docker 서비스 활성화
systemctl enable docker
systemctl start docker

# 5. Git 설치
apt-get install -y git

# 6. 방화벽 설정 (80, 443, 3001 포트 열기)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=== 세팅 완료 ==="
echo "재로그인 후 'docker compose' 명령어를 사용할 수 있습니다."
echo ""
echo "다음 단계:"
echo "  1. git clone <your-repo-url> /home/ubuntu/autocoin"
echo "  2. cd /home/ubuntu/autocoin/backend && cp .env.example .env && nano .env"
echo "  3. cd /home/ubuntu/autocoin && ./deploy/deploy.sh"
