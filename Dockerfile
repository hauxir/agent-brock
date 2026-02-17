FROM ghcr.io/hauxir/brock_samson:60b7a3

USER root
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/

RUN npm ci && npm run build && rm -rf src/ tsconfig.json node_modules && npm ci --omit=dev

RUN chown -R brock:brock /app

USER brock

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health || node -e "process.exit(0)"

ENTRYPOINT []
CMD ["node", "dist/index.js"]
