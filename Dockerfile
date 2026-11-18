FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
