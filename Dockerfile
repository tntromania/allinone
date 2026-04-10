FROM node:22-bookworm

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip wget curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Instalează yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -O /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Creează user non-root
RUN useradd -m -u 1001 appuser

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Directorul downloads aparține appuser
RUN mkdir -p /app/downloads && chown -R appuser:appuser /app

USER appuser

EXPOSE 3000
CMD ["node", "server.js"]