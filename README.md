# Mail IQ

Plataforma de gestão operacional para servidores de e-mail Exim — não é só
monitoramento: existe um ciclo diagnóstico → ação. O script `diag-exim.sh`
roda no servidor monitorado, classifica problemas (`AUTH_ABUSE`, `IP_FLOOD`,
`SPAM_RELAY`, etc.) e o dashboard sugere/executa a ação correta (limpar fila,
bloquear IP, bloquear remetente, forçar reprocessamento).

Nome de código no GitHub: `exim-monitor`.

Suporta ambientes Debian/Ubuntu (`exim4`) e cPanel/WHM. Compatibilidade com
outros painéis (Plesk, DirectAdmin) é trabalho futuro.

## Stack

- **Backend**: FastAPI + PostgreSQL (SQLAlchemy)
- **Frontend**: React + Vite
- **Coleta**: script bash (`diag-exim.sh`) executado via SSH no servidor
  monitorado — o backend não precisa de agente instalado lá, só acesso SSH
- **Infra**: Docker Compose (backend, frontend, Postgres)

## Rodando localmente

### Opção 1 — `install.sh` (recomendado)

Gera segredos fortes automaticamente e sobe tudo:

```bash
./install.sh
```

### Opção 2 — manual

```bash
cp backend/.env.example backend/.env
# edite backend/.env: ADMIN_PASSWORD, JWT_SECRET, SSH_ENCRYPTION_KEY
# para rodar em modo dev sem trocar os segredos, defina ENVIRONMENT=development
# (em produção o backend recusa subir com os valores padrão de fábrica — ver config.py/main.py)

docker compose up -d
```

- Frontend: http://localhost:5173
- Backend (API + docs): http://localhost:8000/api/docs

## Estrutura

```
backend/            API FastAPI
  app/
    routers/         endpoints REST (servers, status, actions, alerts, users…)
    ssh.py           wrapper SSH — executa diag-exim.sh no servidor remoto
    collector.py      coleta periódica em background (quick/full) por servidor
    alerts.py         disparo de alertas (e-mail, Telegram) por servidor
    main.py           entrada da API + migrations versionadas no startup
  alembic/            migration inicial do schema (evolução posterior é
                       feita via DDL versionado direto em main.py)

frontend/            Dashboard React
  src/
    pages/            telas (Dashboard, Servers, Settings, Users…)
    components/        gráficos, painéis de ação/diagnóstico, seletor de servidor
    contexts/           auth, servidor ativo, toasts

diag-exim.sh          script que roda no servidor monitorado — coleta,
                       diagnóstico e ações (--quick / --json / --check / --action=…)
install.sh             instalador (gera .env, sobe Docker Compose, configura proxy)
```

## Roadmap

O roadmap de desenvolvimento (fases de compatibilidade com cPanel/WHM,
hardening de produção, plano de lançamento do MVP) vive fora deste
repositório. Fale com o time do projeto para acesso.
