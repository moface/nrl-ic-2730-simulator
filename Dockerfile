FROM python:3.11-slim
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::Timeout=12 update && apt-get install -y --no-install-recommends libspeexdsp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY softhead/ softhead/
COPY web/ web/
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["python", "-m", "softhead.server"]
CMD ["--config", "/config/config.toml"]
