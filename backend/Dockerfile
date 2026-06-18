FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm install

RUN npx prisma generate

COPY tsconfig.json .
COPY src ./src
RUN npm run build

# ── 프로덕션 이미지 ─────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Prisma 실행에 필요한 OpenSSL 설치
RUN apk add --no-cache openssl

# builder의 node_modules 복사 후 dev 의존성만 제거 (npm install 재실행 없음)
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

COPY package*.json ./
COPY prisma ./prisma

# 빌드 결과물 복사
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
