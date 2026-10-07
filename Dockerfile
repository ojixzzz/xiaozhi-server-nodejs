FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/data /app/tmp && chown -R node:node /app/data /app/tmp
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app.js"]
