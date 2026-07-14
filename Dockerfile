FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]