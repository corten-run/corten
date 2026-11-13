FROM dunglas/frankenphp:1-php8.4-bookworm AS tools
RUN install-php-extensions pcntl intl zip opcache uv >/dev/null \
  && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

FROM tools AS dependencies
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts --no-autoloader --prefer-dist -q

FROM node:24-bookworm-slim AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client.js ./
RUN npm run build

FROM dependencies
COPY . .
COPY --from=assets /app/public/client.js public/client.js
RUN mkdir -p bootstrap/cache storage/framework/cache/data storage/framework/cache/locks storage/framework/sessions storage/framework/views storage/logs \
  && composer dump-autoload --optimize --no-dev --no-scripts -q \
  && php artisan package:discover -q \
  && php artisan octane:install --server=frankenphp -n -q
EXPOSE 8080
CMD ["/bin/sh", "/app/start.sh"]
