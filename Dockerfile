FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
COPY test/ ./test/
# Testy regresji (09.11) - blad testu zatrzymuje budowanie obrazu, wiec i wdrozenie.
RUN npm run build && npm test

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]