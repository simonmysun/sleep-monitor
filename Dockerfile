FROM node:lts-alpine3.19

WORKDIR /app

COPY . /app/

RUN npm install

RUN npm run build
ENV PORT='3000'
ENV HOST='::'
ENV ICAL=''
ENV EVENT_NAME=''
ENV CACHE_EXPIRATION='300'

EXPOSE 3000

ENTRYPOINT [ "node" ]

CMD [ "/app/dist/main.cjs" ]