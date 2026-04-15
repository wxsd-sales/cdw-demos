# Build from repo `tumor-board/` directory so we can COPY sibling `meeting-join` static files:
#   docker build -f meeting-join-server/Dockerfile -t meeting-join .
#
# Run (publish 10031; VIDCAST_PLAYLIST_ID comes from meeting-join-server/.env copied into the image):
#   docker run --rm -p 10031:10031 meeting-join
#
# Chromium + flags mirror Democast @ 876bd83 (.devcontainer/server/nodePuppeteer/customCall.js):
#   apt chromium, executablePath, --no-sandbox, --disable-web-security, --use-fake-ui-for-media-stream, etc.
# Base image is Debian bookworm (supported) instead of Democast’s ubuntu:bionic.


#docker buildx build --platform linux/amd64 -f meeting-join-server/Dockerfile -t cdw-meeting-join .
#docker run --rm -p 10031:10031 cdw-meeting-join

#aws ecr get-login-password --region us-west-1 | docker login --username AWS --password-stdin 191518685251.dkr.ecr.us-west-1.amazonaws.com
#docker tag cdw-meeting-join:latest 191518685251.dkr.ecr.us-west-1.amazonaws.com/cdw-meeting-join:latest
#docker push 191518685251.dkr.ecr.us-west-1.amazonaws.com/cdw-meeting-join:latest

#I think this only has to be done 1 time.
#aws ecr create-repository --repository-name cdw-meeting-join

#kubectl apply -f cdw.yaml
#kubectl rollout restart deployment/cdw -n default
#kubectl rollout status -n default deployment/cdw 

#kubectl get ingress -n cdw-ingress
#kubectl get pods
#kubectl describe pod <pod name>

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    curl \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=10031
ENV STATIC_DIR=/app/meeting-join
ENV NODE_ENV=production

WORKDIR /app

COPY meeting-join-server/package.json meeting-join-server/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY meeting-join-server/server.js meeting-join-server/puppeteer-join.js ./
COPY meeting-join-server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Same idea as Democast Dockerfile (COPY server/.env): playlist id at runtime without docker run -e.
COPY meeting-join-server/prod.env /app/.env

COPY meeting-join /app/meeting-join

EXPOSE 10031
ENTRYPOINT ["/app/docker-entrypoint.sh"]
