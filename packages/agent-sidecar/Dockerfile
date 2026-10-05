FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
ENV PI_SIDECAR_HOST=0.0.0.0 PI_SIDECAR_PORT=8787 PI_SIDECAR_MODE=fake
EXPOSE 8787
USER node
CMD ["node", "src/index.js"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
