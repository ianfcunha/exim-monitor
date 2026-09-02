# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/). A versão
em execução é exposta em `GET /api/version` e no rodapé do painel; ela
bate com a tag git `vX.Y.Z` e com a tag das imagens Docker.

## [Não lançado]

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
