# AutoCoin 서버 운영 메뉴얼

EC2 접속 기준: `ssh -i key.pem ubuntu@<EC2-PUBLIC-IP>`  
작업 디렉토리: `/home/ubuntu/autocoin`

---

## 1. Docker 상태 확인

```bash
# 컨테이너 실행 상태 확인 (Up/Exit 여부)
docker compose -f docker-compose.prod.yml ps

# 백엔드 실시간 로그 (Ctrl+C로 종료)
docker compose -f docker-compose.prod.yml logs -f backend

# 프론트엔드 로그
docker compose -f docker-compose.prod.yml logs -f frontend

# 최근 100줄만 보기
docker compose -f docker-compose.prod.yml logs --tail=100 backend

# 헬스 체크 (정상이면 {"status":"ok",...} 출력)
curl http://localhost:3001/api/health
```

---

## 2. 서버 껐다 켜기

```bash
cd /home/ubuntu/autocoin

# 중지
docker compose -f docker-compose.prod.yml down

# 시작
docker compose -f docker-compose.prod.yml up -d

# 재시작 (한 번에)
docker compose -f docker-compose.prod.yml restart
```

> **주의:** `restart`는 이미지를 새로 빌드하지 않음. 코드 변경 후엔 빌드가 필요 (아래 참고).

---

## 3. 코드 업데이트 후 재배포 (GitHub 경유)

코드를 로컬에서 수정 → GitHub push → EC2에서 pull & 재빌드.

```bash
cd /home/ubuntu/autocoin

# 최신 코드 받기
git pull origin main

# 이미지 다시 빌드 (변경된 서비스만 빌드하려면 backend 또는 frontend 지정)
docker build -t autocoin-backend:latest ./backend
docker build -t autocoin-frontend:latest ./frontend

# 컨테이너 재시작 (새 이미지 적용)
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

또는 deploy 스크립트로 한 번에:

```bash
chmod +x deploy/deploy.sh   # 최초 1회만
./deploy/deploy.sh
```

---

## 4. FileZilla로 파일 직접 수정 후 재시작

환경설정 파일(`.env`) 등 git에 올리지 않는 파일을 FileZilla로 수정했을 때.

```bash
cd /home/ubuntu/autocoin

# .env만 변경했으면 이미지 재빌드 없이 컨테이너만 재시작
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

> **backend/.env 경로**: `/home/ubuntu/autocoin/backend/.env`  
> FileZilla SFTP 접속: 호스트 `sftp://EC2-PUBLIC-IP`, 포트 `22`, 키파일 인증

---

## 5. 도미넌스 데이터 등 정적 데이터 업데이트

데이터 파일(JSON 등)을 FileZilla로 교체한 경우:

```bash
# 파일이 컨테이너 내부에서 읽히는 경우 → 이미지 재빌드 필요
docker build -t autocoin-backend:latest ./backend
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

---

## 6. 데이터베이스 마이그레이션

Prisma 스키마(`schema.prisma`)가 바뀌었을 때.

```bash
# 로컬에서 마이그레이션 파일 생성 후 GitHub push
npx prisma migrate dev --name "변경내용설명"
git add prisma/migrations
git commit -m "db: ..."
git push

# EC2에서 배포하면 컨테이너 시작 시 자동으로 migrate deploy 실행됨
./deploy/deploy.sh
```

---

## 7. 전체 초기화 (주의: 데이터 삭제)

```bash
# 컨테이너 + 이미지 모두 삭제
docker compose -f docker-compose.prod.yml down
docker rmi autocoin-backend:latest autocoin-frontend:latest

# 처음부터 다시 빌드
docker build -t autocoin-backend:latest ./backend
docker build -t autocoin-frontend:latest ./frontend
docker compose -f docker-compose.prod.yml up -d
```

---

## 8. 디스크/메모리 확인

```bash
# 디스크 사용량
df -h

# 메모리
free -h

# Docker가 차지하는 용량
docker system df

# 사용하지 않는 이미지/컨테이너 정리
docker system prune -f
```

---

## 9. 자주 쓰는 명령어 요약

| 목적 | 명령어 |
|------|--------|
| 상태 확인 | `docker compose -f docker-compose.prod.yml ps` |
| 로그 보기 | `docker compose -f docker-compose.prod.yml logs -f backend` |
| 재시작 | `docker compose -f docker-compose.prod.yml restart` |
| 코드 업데이트 배포 | `git pull && ./deploy/deploy.sh` |
| 헬스 체크 | `curl http://localhost:3001/api/health` |
