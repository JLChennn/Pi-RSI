FROM node:22.19.0-bookworm-slim
WORKDIR /
COPY package.json package-lock.json /
RUN npm ci --ignore-scripts --no-audit --no-fund
USER 1000:1000
