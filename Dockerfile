FROM node:boron

ENV TSLA_USERNAME username
ENV TSLA_PASSWORD pwd
ENV MONGOHQ_URI mongodb://localhost:27017/

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY package.json /usr/src/app/
RUN npm install
COPY . /usr/src/app
EXPOSE 3000
CMD [ "npm", "start" ]
