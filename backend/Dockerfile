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

RUN apk add --no-cache openssl

# node_modules 전체 복사 (Prisma 바이너리 포함)
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY prisma ./prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
