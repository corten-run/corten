FROM python:3.14-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ADD --checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js static/htmx.min.js
EXPOSE 8080
# FastAPI's documented production command (fastapi run: uvicorn, no reload). One process, as its
# container guide recommends where the container is given its CPUs (one here), and as the live
# benchmark needs: every stream and the publisher in one process.
CMD ["fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8080"]
