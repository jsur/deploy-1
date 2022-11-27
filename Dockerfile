FROM node:18

WORKDIR /app
COPY ./node_modules ./node_modules
COPY ./server.js ./server.js
ENV NODE_ENV=production
CMD ["node", "server.js"]