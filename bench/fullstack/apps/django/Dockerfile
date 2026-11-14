ARG PROFILE=defaults
FROM python:3.15.2-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DJANGO_SETTINGS_MODULE=itempage.settings
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js static/htmx.min.js
RUN python -m django collectstatic --noinput -v 0
EXPOSE 8080

FROM base AS defaults
# Gunicorn's documented worker count, (2 x CPUs) + 1, for one CPU. --preload loads the items once
# before the workers fork.
CMD ["sh", "-c", "python -m django migrate --noinput && exec gunicorn itempage.wsgi --bind 0.0.0.0:8080 --workers 3 --preload"]

FROM base AS matched
RUN pip install --no-cache-dir -r requirements-matched.txt
ENV PROFILE=matched
CMD ["sh", "-c", "python -m django migrate --noinput && exec python start_matched.py"]

FROM ${PROFILE} AS runtime
