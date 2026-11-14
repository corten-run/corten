FROM dunglas/frankenphp:1-php8.5-trixie@sha256:667c5fffd348d9c3c260803d75956f1d9aace7e4b7331d8893de6f101d7e0e57 AS tools
RUN install-php-extensions pcntl intl zip opcache uv >/dev/null \
  && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY --from=composer:2.11.2@sha256:5bcb28b8d0edc4091125f8218f9d088f998bdfc843f8fbb9a4beb4dcd8625684 /usr/bin/composer /usr/bin/composer

FROM tools AS dependencies
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts --no-autoloader --prefer-dist -q

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client.js ./
COPY --from=dependencies /app/vendor/livewire/livewire/dist/livewire.esm.js vendor/livewire/livewire/dist/livewire.esm.js
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
