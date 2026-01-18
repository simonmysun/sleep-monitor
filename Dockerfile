FROM node:lts-alpine3.19

WORKDIR /app

COPY . /app/

RUN npm install

RUN npm run build
ENV PORT='3000'
ENV HOST='localhost'
ENV ICAL=''
ENV EVENT_NAME=''

EXPOSE 3000

ENTRYPOINT [ "node" ]

CMD [ "/app/dist/main.cjs" ]