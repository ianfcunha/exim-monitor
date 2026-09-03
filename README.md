# Mail IQ

Plataforma de gestão operacional para servidores de e-mail Exim — não é só
monitoramento: existe um ciclo diagnóstico → ação. O script
[`diag-exim/diag-exim.sh`](diag-exim/) roda no servidor monitorado, classifica
problemas (`AUTH_ABUSE`, `IP_FLOOD`, `SPAM_RELAY`, etc.) e o painel
sugere/executa a ação correta (limpar fila, bloquear IP, bloquear remetente,
forçar reprocessamento) — detecta o incidente, notifica onde você já está
(Telegram/e-mail/webhook) e gera o relatório que você encaminha pro seu
cliente.

Nome de código no GitHub: `exim-monitor`.

Suporta ambientes Debian/Ubuntu (`exim4`) e cPanel/WHM. Compatibilidade com
outros painéis (Plesk, DirectAdmin) é trabalho futuro.

## Licenciamento

Este repositório é **open-core** — duas licenças diferentes, sem ambiguidade
sobre onde uma termina e a outra começa:

| | Licença | O que cobre |
|---|---|---|
| [`diag-exim/`](diag-exim/) | **MIT** (permissiva) | O script de diagnóstico/ação sozinho — roda em qualquer servidor Exim, sem o painel, sem conta, sem depender de nada aqui. Use, modifique, redistribua, incorpore no que quiser. |
| Todo o resto (`backend/`, `frontend/`, agregação de frota, histórico, alertas, relatórios) | **Comercial** — ver [`LICENSE`](LICENSE) | O painel: tudo que só existe/funciona com o Mail IQ rodando. Requer licença comercial pra uso além de avaliação. |

Se você só quer diagnosticar e agir manualmente num servidor Exim, o
`diag-exim/` sozinho já resolve — é o pacote que existe pra isso, com README
próprio. O painel existe pra quem opera mais de um servidor e quer o
histórico, os alertas e os relatórios prontos sem construir isso por conta
própria.

Os termos completos de uso do painel — concessão de licença, suas
responsabilidades, limitação de responsabilidade, suporte, dados e foro —
estão em [`EULA.md`](EULA.md) (minuta em português, para revisão
jurídica). A licença é **soft**: um token vencido ou ausente nunca trava
o painel nem para a coleta — só bloqueia o cadastro de servidores novos.
Uma instalação sem token roda em cortesia (1 servidor / 30 dias).

## O que este software executa no seu servidor

Self-hosted é o padrão: você roda o compose na sua própria infraestrutura, e
suas chaves SSH e seus logs nunca saem dela em operação normal — o painel não
faz "phone home", nem para checar a licença. A única coisa que sai é o pacote
de diagnóstico, quando **você** o gera e envia ao suporte, já sem segredos e
com os e-mails pseudonimizados ([`docs/dados.md`](docs/dados.md)). Nada aqui
é omitido — abaixo é a lista literal do que roda no servidor monitorado.

**Nunca pedimos a senha de root.** A instalação recomendada
(`mailiq-bootstrap.sh` — leia o arquivo inteiro antes de rodar) cria um
usuário dedicado, `mailiq`, sem senha, só chave SSH, e concede exatamente os
comandos abaixo via `/etc/sudoers.d/mailiq` — nada além disso. Sem
`ALL=(ALL) NOPASSWD: ALL` em lugar nenhum. A allowlist completa e comentada,
pra você auditar antes de instalar, está em [`docs/seguranca.md`](docs/seguranca.md).

**Comandos que o Mail IQ executa remotamente**, agrupados pelo que
habilitam:

| O que faz | Comandos |
|---|---|
| Ler a fila e o log (sem privilégio nenhum, só grupo de leitura) | `exim4 -bp`, `exim4 -bpc`, `exiqgrep`, leitura do mainlog |
| Remover mensagens da fila | `exim4 -Mrm`, `exim4 -Mvh`, `exim4 -qff` |
| Bloquear IP (nesta ordem — a primeira ferramenta que existir no seu servidor) | `csf -td` / `firewall-cmd --add-rich-rule --timeout` / `iptables -I INPUT -s <ip> -j DROP` |
| Desbloquear IP | `csf -tr` / `csf -dr` / `imunify360-agent ip-list local delete --purpose black` / `iptables -D INPUT` |
| Bloquear remetente | escrita em `/etc/exim4/spammer_sender` |
| Quarentenar mensagem antes de remover | `cp` do spool do Exim para `/var/spool/exim_quarantine/<incidente>/`, e de volta na restauração |
| Diagnóstico de configuração (só leitura) | `exim4 -bP config`, checagem de STARTTLS, versão do Exim, cPanel/CSF/Imunify360 |

**O que isso garante, não só o que executa:**

- **Nunca apaga direto.** Toda remoção passa por quarentena primeiro — os
  arquivos da mensagem são copiados antes de `-Mrm` rodar, com restauração de
  um clique, por 7 dias (configurável) antes da remoção virar definitiva.
- **Nunca reinicia seu firewall.** Bloqueio de IP prefere a ferramenta nativa
  do seu servidor (CSF, firewalld) — que já expira sozinha — e só cai pra
  `iptables` cru como último recurso, sempre com TTL e sem `systemctl restart`
  em lugar nenhum.
- **Nunca finge sucesso.** Toda ação reconsulta a fila depois de agir — se
  não conseguir remover 4.113 mensagens porque faltou permissão, o painel diz
  exatamente isso, com os IDs que sobraram, nunca "concluído".
- **Nunca age sem plano.** Toda ação passa por uma fase `plan()` — mostra o
  que faria, sem alterar nada — antes de uma `apply()` liberada por um
  `plan_id` de uso único, válido por 5 minutos. "Limpar toda a fila" (a única
  ação de escopo total) exige digitar o nome do servidor.
- **Nunca finge que o log é normal.** Se o formato do log não é reconhecido,
  o servidor é marcado como degradado — nunca "0 mensagens" como se
  estivesse tudo bem. Matriz de compatibilidade em
  [`docs/compatibilidade.md`](docs/compatibilidade.md).
- **Tudo fica registrado.** Quem, quando, qual plano, o resultado real e como
  reverter — inclusive tentativas negadas e falhas de conexão. Exportável em
  CSV/JSON, por servidor e por período.

## Stack

- **Backend**: FastAPI + PostgreSQL (SQLAlchemy)
- **Frontend**: React + Vite
- **Coleta**: script bash (`diag-exim.sh`) executado via SSH no servidor
  monitorado — o backend não precisa de agente instalado lá, só acesso SSH
- **Infra**: Docker Compose (backend, frontend, Postgres)

## Instalação — dois caminhos separados

São duas coisas diferentes, em duas máquinas diferentes: instalar o painel
(uma vez) e conectar cada servidor EXIM que ele vai monitorar (uma vez por
servidor). `install.sh` só faz a primeira; `mailiq-bootstrap.sh` só faz a
segunda — nenhum dos dois faz o trabalho do outro.

### 1. O painel — `install.sh`, na máquina onde o Mail IQ vai rodar

Gera segredos fortes automaticamente e sobe tudo (Docker Compose):

```bash
./install.sh
```

Ou manualmente:

```bash
cp backend/.env.example backend/.env
# edite backend/.env: ADMIN_PASSWORD, JWT_SECRET, SSH_ENCRYPTION_KEY
# para rodar em modo dev sem trocar os segredos, defina ENVIRONMENT=development
# (em produção o backend recusa subir com os valores padrão de fábrica — ver config.py/main.py)

docker compose up -d
```

- Frontend: http://localhost:5173
- Backend (API + docs): http://localhost:8000/api/docs

Nenhum dos dois caminhos toca em nenhum servidor EXIM — só sobe o painel.

### 2. Cada servidor EXIM — `mailiq-bootstrap.sh`, no servidor monitorado

No painel, em Servidores → Adicionar → "Gerar chave", copie a chave pública
mostrada. No servidor EXIM (**não** na máquina do painel), como root, uma
única vez — leia o script inteiro antes:

```bash
bash mailiq-bootstrap.sh --pubkey 'ssh-ed25519 AAAA... mailiq@seuservidor'
```

Isso cria o usuário `mailiq`, instala a chave, escreve o sudoers mínimo (ver
tabela acima) e imprime uma sondagem do que a conexão consegue fazer. Volte
ao painel e clique "Testar conexão" — sem ter digitado nenhuma senha de root
nele em momento nenhum. Detalhes em [`docs/seguranca.md`](docs/seguranca.md).

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

diag-exim/              pacote open-core (MIT — ver diag-exim/LICENSE), autônomo
  diag-exim.sh           script que roda no servidor monitorado — coleta,
                         diagnóstico e ações (--quick / --json / --check / --action=…)
  README.md              uso standalone, sem o painel
  LICENSE                MIT
mailiq-bootstrap.sh    roda uma vez, como root, NO SERVIDOR MONITORADO —
                       cria o usuário mailiq, instala a chave, escreve o
                       sudoers mínimo
install.sh             instalador do painel A PARTIR DO CÓDIGO (gera .env,
                       builda e sobe Docker Compose) — não toca em nenhum
                       servidor EXIM
deploy/                deploy a partir de imagens versionadas (ghcr.io),
                       sem código-fonte na máquina — compose + install.sh +
                       upgrade.sh (com rollback) + docs. É o pacote que o
                       cliente recebe; autocontido, com README próprio
LICENSE                comercial — cobre tudo neste repositório EXCETO diag-exim/
EULA.md                contrato de licença de uso do painel (minuta pt-BR,
                       para revisão jurídica) — concessão, responsabilidades,
                       limitação de responsabilidade, suporte, dados, foro
docs/
  manual.md             manual do painel — cada tela e os conceitos por
                        trás delas; a doc que você passa a quem vai operar
  seguranca.md          sudoers de referência completo, pra auditar antes
                        de instalar
  suporte.md            como o suporte funciona — best-effort, sem SLA;
                        o pacote de diagnóstico; escopo e rede de segurança
  compatibilidade.md    matriz de formatos de log validados vs. inferidos
  dados.md               que dados o sistema lê, onde ficam, retenção, e o
                        pacote de diagnóstico — a resposta pra LGPD
tests/                  testes automatizados contra Exim/iptables/API reais
  fixtures/              amostras de mainlog por formato
```

## Roadmap

O roadmap de desenvolvimento (fases de compatibilidade com cPanel/WHM,
hardening de produção, plano de lançamento do MVP) vive fora deste
repositório. Fale com o time do projeto para acesso.
