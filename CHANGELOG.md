# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/). A versão
em execução é exposta em `GET /api/version` e no rodapé do painel; ela
bate com a tag git `vX.Y.Z` e com a tag das imagens Docker.

## [Não lançado]

### Adicionado
- **`EULA.md`** — minuta do contrato de licença de uso do painel, em
  português, para revisão jurídica antes da primeira venda. Cobre
  concessão de licença, o comportamento soft do token (`MAILIQ_LICENSE`
  vencido nunca trava o painel), responsabilidades do cliente (revisar o
  Plano antes de aplicar cada ação), limitação de responsabilidade — com
  ênfase nas ações destrutivas e na não entrega de e-mail —, suporte
  best-effort sem SLA, tratamento de dados (remete a `docs/dados.md`,
  inclui o pacote de diagnóstico) e foro na comarca do cliente. Aviso no
  topo de que não substitui advogado; marcadores para razão social,
  CNPJ e endereço.
- **`docs/suporte.md`** — como o suporte funciona: best-effort, horário
  comercial, sem SLA; o que fazer antes de abrir chamado; o pacote de
  diagnóstico; o que está e o que não está no escopo; a rede de
  segurança (quarentena, bloqueio com TTL, preview) que torna a maior
  parte das reversões self-service.
- **Pacote de diagnóstico** (Configurações → Manutenção, admin only):
  um arquivo com versão em execução, estado do coletor e do watchdog,
  licença, servidores e checagens, quais canais de alerta estão ligados e
  completos, e os incidentes recentes com as linhas de log que os provam.
  O chamado típico gastava três mensagens só para levantar isso.
  Como o arquivo **sai da máquina do cliente**, ele tem duas garantias:
  · Segredo nenhum. Os campos sensíveis não entram, E o JSON final passa
    por uma limpeza que remove por VALOR qualquer segredo conhecido
    (chave Fernet, JWT, senha do banco e do admin, token da licença,
    credenciais de canal) mais qualquer token Fernet. Se um campo novo
    vazar amanhã, a segunda camada ainda pega — e loga um aviso pedindo
    para corrigir a origem.
  · Dado pessoal pseudonimizado. As linhas de mainlog carregam remetente
    e destinatário, que num painel de hospedagem são os clientes finais
    do cliente. A parte local vira `conta#a1b2c3` (HMAC com chave que
    nunca sai da instalação: estável entre pacotes do mesmo painel,
    inútil fora dele, irreversível por dicionário) e **o domínio fica**,
    porque é ele que explica o problema de entrega e sozinho não
    identifica pessoa.
  Botão "Ver o conteúdo antes" mostra o mesmo arquivo na tela: pedir para
  o cliente enviar algo sem poder ler o que envia não é aceitável.
  O download fica registrado no histórico de auditoria.
- `deploy/diagnostic.sh` — o que o painel não enxerga de si mesmo:
  containers, log de cada serviço, disco, memória, Docker, portas em
  escuta e certificado. É o que resta quando o painel está fora do ar e
  por isso não consegue gerar o próprio diagnóstico. O `.env` não entra —
  só a lista de variáveis definidas, sem os valores. Avisa se um segredo
  do `.env` aparecer dentro de algum log capturado.
- `tests/test_diagnostic_package.sh` — teste adversarial: planta canários
  em todos os campos de credencial do banco e falha se qualquer um sair
  no pacote. Canário porque, num painel recém-instalado, quase todo campo
  de credencial está vazio e um teste de "campo vazio" passaria sem
  testar nada. 17 asserções.
- **Watchdog do coletor** — o painel inteiro dependia de uma
  `asyncio.Task` continuar rodando. Se ela morresse ou travasse, as telas
  seguiam servindo o último snapshot, o selo de saúde seguia verde e
  nenhum alerta disparava, porque alerta é disparado *pela* coleta: a
  falha do monitoramento era indistinguível de "está tudo bem". Agora um
  loop separado verifica a cada 60s e cobre os três modos de falha:
  task morta (religa e alerta, com a exceção que a matou no log), task
  viva mas sem concluir ciclo (religa e alerta), e servidor que parou de
  responder apesar do coletor saudável (alerta deadman com aviso de
  recuperação quando volta).
- **Alertas operacionais** — categoria à parte, para quando o problema é
  o próprio monitoramento. Não passam pelo `severity_threshold`: o
  limiar existe para o operador dosar o barulho sobre a saúde do e-mail,
  não para silenciar "o painel parou de enxergar". Cooldown próprio de
  30 min, e a mensagem de recuperação ignora o cooldown.
- `GET /api/status/collector` — estado do coletor e do watchdog (último
  ciclo, ciclos concluídos, religamentos, servidores mudos). Existe
  porque "há quanto tempo este servidor foi coletado" não distingue
  "o servidor sumiu" de "o coletor parou" — problemas diferentes.
- `tests/test_watchdog.sh` (no CI) — 29 asserções com coletor falso e
  relógio empurrado à mão: os três modos de falha, as recuperações sem
  repetição, servidor recém-cadastrado que não conta como silencioso,
  servidor removido enquanto mudo, cooldown e independência do limiar.
- `app/ssh_access.py` — caminho único para montar a config SSH de um
  servidor e reportar segredo ilegível.
- `tests/_license_guard.sh` — testes que criam servidor descartável
  agora pulam com o motivo quando a licença está no teto, em vez de
  falharem por um motivo alheio ao que medem.
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
- **Licença visível no painel** (só Admin): bloco "Licença" em
  Configurações → Geral com cliente, identificador, vencimento, dias
  restantes e servidores em uso do total contratado; faixa no topo do
  painel quando o estado não é `ok` — âmbar quando ainda dá tempo (vence
  em ≤14 dias, cortesia correndo), vermelha quando venceu ou o token não
  confere. O texto sempre diz, na mesma frase, o que **não** acontece: o
  monitoramento não para. No estado normal a faixa não aparece.
  O botão "Adicionar servidor" fica desabilitado com o motivo no tooltip
  quando o limite é atingido — em vez de deixar o clique falhar depois.
  O motivo vem pronto do backend, então é literalmente o mesmo texto que
  a API responderia.
- `docs/manual.md` — seção "Configurações → Geral: a licença": o que a
  licença cobre, o que acontece (e o que não acontece) quando vence, a
  cortesia de instalação e como instalar/renovar o token.
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
- **`LICENSE`** reescrito como aviso que remete ao `EULA.md`: mantém a
  fronteira open-core (`diag-exim/` é MIT e sobrevive ao término),
  descreve a verificação offline do token e o comportamento soft, e
  torna explícito que o cliente é responsável por revisar o Plano de
  cada ação — a limitação de responsabilidade deixou de ser uma linha
  genérica.
- **`docs/dados.md`** atualizado para o estado atual: nova seção "A
  licença" (o `.env` guarda `MAILIQ_LICENSE` com o nome do cliente;
  verificação local, sem phone-home); nova seção "O pacote de
  diagnóstico" (o único dado que sai da infra do cliente, e só por ação
  dele); a afirmação "nada sai para nós" passou a nomear essa exceção em
  vez de ser absoluta.
- `README.md` — licenciamento remete ao `EULA.md` e descreve o token
  soft; a seção "o que executa no seu servidor" nomeia o pacote de
  diagnóstico como a única saída de dados; `EULA.md` e `docs/suporte.md`
  entram na listagem de estrutura.
- `decrypt_secret()` falha alto desde a Sessão 1, mas isso só resolve se
  TODO chamador tratar — e o bloco de tratamento estava copiado em quatro
  routers e **ausente em dois**. `messages.py` (Log Viewer) e `status.py`
  (coleta forçada) montavam o dict de config à mão, sem passar por
  `build_server_cfg()`, e respondiam **500 com o erro cru** quando a
  `SSH_ENCRYPTION_KEY` não batia com o segredo salvo — exatamente o
  sintoma que a mudança da Sessão 1 existia para eliminar, sobrevivendo
  nos dois lugares que esqueceram de adotá-la. Os seis caminhos agora
  passam por `ssh_access.server_cfg_or_503()`: **503 com o motivo
  legível** e o servidor marcado como "Erro de credencial" na hora.
  Verificado nos dois sentidos — o código anterior devolvia 500, o atual
  devolve 503 com a frase que diz o que fazer.
- A atualização de evidência de incidente (best-effort, engolia tudo)
  passa a marcar o servidor quando o motivo é segredo ilegível: continua
  não quebrando a abertura do incidente, mas o erro não some mais.
- `docs/manual.md` e `deploy/.env.example` avisam que trocar a licença
  exige `docker compose up -d backend`, não `restart` — `restart`
  reaproveita o container e não relê o `.env`.
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
