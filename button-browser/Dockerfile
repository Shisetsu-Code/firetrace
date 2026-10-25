FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOST=0.0.0.0 PORT=8766
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npx playwright install --with-deps chromium
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data /ms-playwright
USER node
EXPOSE 8766
CMD ["node", "src/server.cjs"]
