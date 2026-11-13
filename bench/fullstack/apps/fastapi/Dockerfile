FROM python:3.14-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js static/htmx.min.js
EXPOSE 8080
# FastAPI's documented production command (fastapi run: uvicorn, no reload). One process, as its
# container guide recommends where the container is given its CPUs (one here), and as the live
# benchmark needs: every stream and the publisher in one process.
# The matched tier's profile (PROFILE=matched) runs the same uvicorn as FastAPI's "Run a Server
# Manually" starts it, since `fastapi run` has no setting for uvicorn's connection cap
# (--limit-concurrency, MAX_CONNECTIONS; past it uvicorn answers 503).
CMD ["sh", "-c", "if [ \"$PROFILE\" = matched ]; then exec uvicorn app.main:app --host 0.0.0.0 --port 8080 ${MAX_CONNECTIONS:+--limit-concurrency \"$MAX_CONNECTIONS\"}; else exec fastapi run app/main.py --host 0.0.0.0 --port 8080; fi"]
