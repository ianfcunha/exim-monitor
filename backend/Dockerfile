FROM python:3.12-slim

# gcc + libs de build para wheels que eventualmente compilem do source
# (a maioria das deps ja vem como wheel manylinux; psycopg2-binary embute o libpq)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# SHA do commit publicado — o CI passa via --build-arg MAILIQ_BUILD_SHA=$GITHUB_SHA.
# Sem isso (build local / compose sem CI) o backend reporta build_sha="dev".
ARG MAILIQ_BUILD_SHA=""
ENV MAILIQ_BUILD_SHA=$MAILIQ_BUILD_SHA

EXPOSE 8000

# Servidor ASGI de producao. O docker-compose.prod.yml passa o mesmo
# comando com --proxy-headers (atras do Caddy). Um unico worker de
# proposito: o coletor em background usa cache em memoria no processo.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
