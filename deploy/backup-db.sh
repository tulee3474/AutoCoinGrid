#!/bin/bash
# DB 전체 백업 — crontab에 등록해서 매일 자동 실행 (RDS 자동 백업 대체용)
# 최근 3일치만 보관(디스크 용량이 빠듯해 보관 기간을 짧게 잡음) — 최초 1회 등록:
#   0 4 * * * /home/ubuntu/autocoin/deploy/backup-db.sh >> /home/ubuntu/autocoin/backend/data/backups/backup.log 2>&1
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BACKUP_DIR="$REPO_DIR/backend/data/backups"
mkdir -p "$BACKUP_DIR"

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "오류: $REPO_DIR/.env 파일이 없습니다 (MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE 필요)"
  exit 1
fi

# docker-compose.prod.yml과 같은 .env에서 MySQL 자격증명 로드
set -a
source "$REPO_DIR/.env"
set +a

DATE=$(date +%F)
DUMP_FILE="$BACKUP_DIR/db-$DATE.sql.gz"

docker compose -f docker-compose.prod.yml exec -T mysql \
  mysqldump -u "${MYSQL_USER:-autocoin}" -p"${MYSQL_PASSWORD}" --single-transaction "${MYSQL_DATABASE:-autocoin}" \
  | gzip > "$DUMP_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 백업 완료: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# 3일 지난 백업 자동 삭제
find "$BACKUP_DIR" -name "db-*.sql.gz" -mtime +3 -delete
