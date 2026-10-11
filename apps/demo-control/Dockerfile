FROM node:20-alpine
WORKDIR /app
# kubectl is required for the agent log tailer in server.js.
RUN apk add --no-cache curl && \
    curl -fsSL -o /usr/local/bin/kubectl https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl && \
    chmod +x /usr/local/bin/kubectl
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public/ ./public/
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
