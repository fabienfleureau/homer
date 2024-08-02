FROM node:18

RUN mkdir -p /home/node/app \
    && chown -R node:node /home/node/app

WORKDIR /home/node/app

ENV NODE_ENV=production

EXPOSE 3000

USER node
COPY --chown=node:node . /home/node/app
RUN yarn install --production=false && yarn build

CMD ["node", "dist/src/index.js"]
