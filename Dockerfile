FROM python:3.11-slim
WORKDIR /app
COPY softhead/ softhead/
COPY web/ web/
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["python", "-m", "softhead.server"]
CMD ["--config", "/config/config.toml"]
