# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS build
WORKDIR /app

# Enforce lockfile-driven installs
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
WORKDIR /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist ./

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
