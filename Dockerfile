FROM node

COPY package.json .

COPY . .

RUN npm install

ENV PORT 7070

EXPOSE $PORT

CMD ["node",  "index.jS"]