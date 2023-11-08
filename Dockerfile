FROM node:16

WORKDIR /usr/src/app
COPY . /usr/src/app

RUN npm install

CMD [ "npm", "run", "prod" ]