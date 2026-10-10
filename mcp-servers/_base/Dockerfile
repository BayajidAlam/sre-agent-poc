FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
EXPOSE 8080
# Per-shim Dockerfiles (in mcp-servers/<shim>/Dockerfile) extend this base
# with `FROM shim-base:dev` and `COPY app.py [extra files] ./` then
# `CMD ["python", "app.py"]`.
