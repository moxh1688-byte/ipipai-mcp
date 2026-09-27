FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# IP databases must be mounted — they are licensed and not part of this image
VOLUME /data
ENV DATA_DIR=/data \
    MCP_TRANSPORT=http

EXPOSE 3300
CMD ["node", "dist/index.js"]
