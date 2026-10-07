FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/
EXPOSE 8080
ENV PORT=8080
CMD ["node", "-r", "./src/otel.js", "src/server.js"]