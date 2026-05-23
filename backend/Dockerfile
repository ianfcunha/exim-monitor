FROM python:3.12-slim

# uWSGI precisa de gcc + python3-dev para compilar
# psycopg2-binary precisa de libpq-dev (cliente PostgreSQL)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc python3-dev libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uwsgi", "--ini", "uwsgi.ini"]
