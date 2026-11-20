FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    FOURDOTS_HOST=0.0.0.0 \
    FOURDOTS_PORT=8080 \
    FOURDOTS_DATA=/data \
    FOURDOTS_PUBLIC=/app/public \
    FOURDOTS_MAX_MB=1024 \
    FOURDOTS_PART_MB=64 \
    FOURDOTS_KDF_ITERATIONS=600000 \
    FOURDOTS_RAM_DIR=/ram \
    FOURDOTS_SSD_DIR=/data/drops \
    FOURDOTS_RAM_MIN_MB=2048 \
    FOURDOTS_RAM_MAX_MB=0 \
    FOURDOTS_RAM_MIN_FREE_MB=64 \
    FOURDOTS_SWEEP_SECONDS=15 \
    FOURDOTS_ORPHAN_GRACE_SECONDS=21600 \
    FOURDOTS_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302

WORKDIR /app
COPY server.py /app/server.py
COPY public /app/public

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/status',timeout=4)"

CMD ["python", "/app/server.py"]
