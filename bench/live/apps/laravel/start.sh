#!/bin/sh
set -eu
export APP_ENV=production APP_DEBUG=false APP_URL=http://127.0.0.1:8080
export CACHE_STORE=file SESSION_DRIVER=file QUEUE_CONNECTION=sync LOG_CHANNEL=stderr
export REVERB_APP_ID=native-live REVERB_APP_KEY=native-live-public-key
export REVERB_HOST=127.0.0.1 REVERB_PORT=8081 REVERB_SCHEME=http REVERB_SERVER_PORT=8081
export REVERB_APP_SECRET="${REVERB_APP_SECRET:-$(php -r 'echo bin2hex(random_bytes(32));')}"
export APP_KEY="${APP_KEY:-$(php -r 'echo "base64:".base64_encode(random_bytes(32));')}"
php artisan reverb:start --host=127.0.0.1 --port=8081 &
reverb=$!
php artisan octane:frankenphp --host=0.0.0.0 --port=8080 --workers=2 --caddyfile=/app/Caddyfile &
octane=$!
cleanup() {
    trap - TERM INT EXIT
    kill -TERM "$reverb" "$octane" 2>/dev/null || true
    wait "$reverb" "$octane" 2>/dev/null || true
}
trap cleanup TERM INT EXIT
while kill -0 "$reverb" 2>/dev/null && kill -0 "$octane" 2>/dev/null; do sleep 1; done
exit 1
