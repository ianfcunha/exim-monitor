# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/). A versão
em execução é exposta em `GET /api/version` e no rodapé do painel; ela
bate com a tag git `vX.Y.Z` e com a tag das imagens Docker.

## [Não lançado]

### Adicionado
- **Licença de uso**, verificada offline (assinatura Ed25519, chave pública
  embutida no backend). O painel não fala com nenhum servidor de
  licenciamento — funciona em rede fechada, sem telemetria. O token vai em
  `MAILIQ_LICENSE` no `.env`; `GET /api/license` (admin) mostra cliente,
  vencimento, dias restantes e servidores usados/contratados.
  A licença é **soft de propósito**: vencida, inválida ou ausente ela nunca
  trava o painel, nunca o deixa somente-leitura, nunca para o coletor dos
  servidores já cadastrados e nunca apaga dado. A única consequência é
  `POST /api/servers` recusar (403) o cadastro de servidores **novos**, com
  o motivo em texto claro. Instalação sem licença entra em cortesia:
  1 servidor por 30 dias a contar da instalação.
- `tools/issue-license.py` — emissão e conferência de licenças (uso
  interno). `new-key` gera o par de assinatura, `issue` emite o token,
  `verify` confere contra a mesma chave pública que o backend usa. A chave
  privada mora fora do repositório (default `~/.mailiq/license-signing-key.pem`).
- `tests/test_license.sh` (no CI): token válido, payload adulterado,
  assinatura de outra chave, vencida, vencendo em ≤14 dias, teto de
  servidores (N passa, N+1 recusa) e as duas pontas da cortesia.
- `deploy/` — pacote de deploy autocontido: roda o painel a partir de
  imagens versionadas do ghcr.io, sem código-fonte na máquina. Inclui
  `docker-compose.yml` (imagens `${MAILIQ_VERSION}`), `install.sh`,
  `upgrade.sh` com verificação de saúde e rollback automático da imagem,
  `.env.example` e `docs/`.
- `deploy/backup.sh` — tarball com dump do Postgres + `.env` (a chave
  Fernet vai junta, sem ela o dump é inútil). Não-interativo; o
  `upgrade.sh` o executa antes de atualizar.
- `deploy/restore.sh` — restaura um backup. **Antes de tocar em qualquer
  coisa**, valida (via `deploy/check-key.py`, rodado na imagem do backend)
  que a `SSH_ENCRYPTION_KEY` do backup decifra os segredos do dump; se não
  decifra, aborta. Recria o banco, aplica o dump e injeta só a chave
  Fernet no `.env` atual (mantém `POSTGRES_PASSWORD`/`DOMAIN` da máquina).
  Preserva o volume do Caddy.
- CI publica as imagens no **GitHub Container Registry** (`ghcr.io`): tag
  git `vX.Y.Z` → `:X.Y.Z`, `:X.Y` e `:latest`; push na `main` → `:main`
  e `:sha-<curto>`; PR → build de validação sem push. O SHA do commit
  entra na imagem via `MAILIQ_BUILD_SHA` (aparece em `/api/version`).
- A imagem do backend passa a embutir `diag-exim/` em `/app/diag-exim/`
  (o CI copia antes do build) — necessário para o deploy sem repositório.
- Dump automático do banco **antes** de aplicar migrations num banco
  existente que está atrás da versão atual (`pre-migration-<de>-<para>-<ts>.sql`
  em `/app/backups`). Falha do dump só avisa, não bloqueia.
- `tests/test_migrations.sh` + workflow **Migrations** no CI: prova
  idempotência (segundo boot é no-op; `alembic_version` carimbado para
  trás sobe de volta a 024 sem duplicar nem apagar dados) em Postgres
  descartável.
- Imagem do backend passa a incluir `postgresql-client` (`pg_dump`/`psql`).
- Workflow **Tests** no CI (todo push/PR): job backend (`compileall` +
  `import app.main` + `tests/run-ci.sh` — detectores, reconhecimento de
  log, sanidade de checagem), job frontend (`npm ci` + `npm run build`),
  job shell (`bash -n` em todo `*.sh` + shellcheck nos instaladores).
- `tests/README.md` — categoriza os 27 testes e diz o que roda no CI e
  por que os demais (stack de dev / Exim real) não rodam ainda.

### Alterado
- CI migrado do Docker Hub para o `ghcr.io` (pacotes privados de graça,
  autenticação pelo `GITHUB_TOKEN` nativo).
- `run_migrations()`: se a aplicação de uma migration falha, a transação
  reverte (o banco não fica meio-migrado) e o startup é abortado com o
  caminho do dump pré-migração no log.
- Backfills de dados das migrations 003, 023 e 024 passam a rodar só
  quando a coluna que acompanham é nova — re-rodar a migration não
  recomputa overrides de alerta nem reapaga histórico.

## [1.0.0] — 2026-09-02

Primeira versão numerada. O painel já rodava em produção no piloto
(i7host, servidor cPanel) desde 2026-09-01; builds anteriores usavam
numeração ad hoc não rastreável. Esta entrada consolida o estado no
momento do corte.

### Adicionado
- `GET /api/version` (sem autenticação) e rótulo de versão no rodapé do
  painel — `version`, `build_sha` (injetado no build da imagem),
  `started_at` e `schema_version`.
- Motor de incidentes: baseline por conta, pisos mínimos, histerese na
  entrada e na saída, 4º estado `desconhecido` que nunca abre incidente.
- Quatro detectores: `auth_abuse`, `reputation`, `queue_stuck`,
  `dest_deferral`, com evidência por tipo e limiares editáveis na UI.
- Fluxo de ação seguro: `plan()` → preview → `apply()` com `plan_id` de
  uso único (5 min); toda remoção passa por quarentena (janela de
  restauração de 7 dias); bloqueio de IP com TTL, preferindo CSF/firewalld.
- Coleta via SSH executando `diag-exim.sh` no servidor monitorado —
  cadência `quick` 30s / `full` 300s.
- Frota multi-servidor, escopo de servidor obrigatório e selo de saúde
  como fonte única (`health.py`, servindo `/api/status/health` e
  `/api/incidents/summary`).
- Métricas: funil de entrega, throughput, top ofensores, recursos do
  Exim, Log Viewer com exportação CSV/TXT.
- Reputação: DNSBL, SPF/DKIM/DMARC, validade do certificado TLS.
- Alertas por e-mail / Telegram / webhook, canal global com override por
  servidor; relatórios de incidente com link de leitura por validade.
- Onboarding: `install.sh` (HTTPS/Caddy, reverse-proxy ou localhost) e
  `mailiq-bootstrap.sh` (cria o usuário `mailiq` sem senha, só chave, com
  sudoers mínimo no servidor monitorado).
- Indicador de frescor da coleta no cabeçalho — check verde quando
  coletando normal, alerta vermelho quando parou ou passou de 15 min.
- Pool de conexões SSH: uma conexão viva por servidor em vez de um login
  por comando (corrige a enxurrada de "SSH login alert" do lfd/CSF no
  cPanel).
- `docs/manual.md` — manual do painel para quem opera e atende o cliente.

### Corrigido
- Backend de produção roda `uvicorn` (não `uwsgi`, que carregava o
  FastAPI como WSGI e derrubava todo request).
- `install.sh` reentrante: reaproveita `POSTGRES_PASSWORD` /
  `SSH_ENCRYPTION_KEY` / `JWT_SECRET` de instalação anterior em vez de
  regenerar e quebrar a autenticação do Postgres.
- Semeadura idempotente do usuário admin no boot (erro 500 ao cadastrar
  servidor em banco novo).
- Evidência de incidente de fila travada não aparecia vazia; boxes de
  métrica não truncam mais.
- Selo de saúde da frota não pisca em blip isolado de checagem
  (histerese de 3 leituras `desconhecido`).
- Vocabulário do incidente sem jargão interno (nomes de regra de detector
  não aparecem mais na UI).

[Não lançado]: https://github.com/ianfcunha/exim-monitor/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ianfcunha/exim-monitor/releases/tag/v1.0.0
