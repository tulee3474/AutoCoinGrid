FROM node:20-alpine AS builder
WORKDIR /app

# 의존성 설치
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Prisma 클라이언트 생성 (alpine 네이티브 바이너리)
RUN npx prisma generate

# TypeScript 빌드
COPY tsconfig.json .
COPY src ./src
RUN npm run build

# ── 프로덕션 이미지 ─────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma

# 프로덕션 의존성만 설치
RUN npm ci --omit=dev

# 빌더에서 생성된 Prisma 네이티브 바이너리 복사 (같은 alpine 환경이므로 호환)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# 빌드 결과물 복사
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
