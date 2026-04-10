FROM node:20-bullseye-slim

# Instalam FFmpeg (strict necesar pentru procesare video)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalam dependentele Node
COPY package*.json ./
RUN npm install

# Copiem fisierele noastre
COPY . .

# Cream folderele necesare
RUN mkdir -p downloads && chmod 777 downloads
RUN mkdir -p public && chmod 777 public

EXPOSE 3000

CMD ["node", "server.js"]