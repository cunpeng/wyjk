# 支持 amd64 和 arm64 多架构构建
FROM --platform=$TARGETOS/$TARGETARCH node:18-alpine

LABEL maintainer="wyjk"
LABEL description="网页变动监控器"
LABEL version="1.04"
LABEL org.opencontainers.image.source="https://github.com/yourusername/wyjk"

WORKDIR /app

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p data

EXPOSE 6822

CMD ["node", "server.js"]
