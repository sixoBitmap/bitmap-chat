FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# ci (not install) so the image is built from the lockfile, exactly like local
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# Render injects PORT; 3100 is only the local default (src/server.js reads env)
EXPOSE 3100
CMD ["node", "src/server.js"]
