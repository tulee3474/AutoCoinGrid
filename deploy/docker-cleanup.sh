#!/bin/bash
# 안 쓰는 Docker 이미지/빌드 캐시/중지된 컨테이너 주기적 정리 — crontab에 등록해서 자동 실행
# (볼륨은 절대 안 건드림 — mysql_data 등 데이터는 안전)
# 최초 1회 등록: crontab -e 에 아래 한 줄 추가
#   0 3 * * 0 /home/ubuntu/autocoin/deploy/docker-cleanup.sh >> /home/ubuntu/autocoin/backend/data/backups/docker-cleanup.log 2>&1
set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Docker 정리 시작"
docker system prune -a -f
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Docker 정리 완료 — 디스크 현황:"
df -h / | tail -1
