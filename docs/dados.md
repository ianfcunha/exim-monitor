# Dados — o que o Mail IQ lê, onde fica, e por quanto tempo

Sessão 3, Tarefa 5. Este documento existe pra responder a pergunta de
LGPD (ou qualquer due diligence de dados) antes de ela ser feita — sem
precisar ler código pra descobrir. É preciso e literal, não marketing:
onde a resposta é "não sabemos ainda" ou "não é reforçado
automaticamente", está escrito assim.

## Por que a arquitetura é self-hosted

O Mail IQ não opera nenhuma infraestrutura que recebe seus dados. Você
sobe o painel (`docker compose up`) na sua própria máquina/VPS; ele se
conecta aos seus servidores Exim via SSH usando credenciais que você
fornece. Nenhum log, nenhum endereço de e-mail, nenhuma credencial SSH
sai da sua infraestrutura para nós — porque não existe um "nós" no
caminho dos dados, só o seu painel e os seus servidores.

Isso importa porque, para efeito de LGPD/GDPR, os e-mails processados
pelos servidores que você opera pertencem aos SEUS clientes — você é o
controlador (ou operador) desses dados perante eles. Ao rodar o Mail IQ
self-hosted, você não introduz um terceiro (nós) na cadeia de
tratamento desses dados — o relacionamento continua sendo só entre
você e o dono da caixa postal. Isto é uma escolha de arquitetura
deliberada, não um acidente: a alternativa (um SaaS multi-tenant que
processa o log de todo cliente numa infra central) exigiria contratos
de processamento de dados com cada host que usasse o produto — o
self-hosted elimina essa camada inteira.

## O que é lido no servidor monitorado

Via SSH, o [`diag-exim/diag-exim.sh`](../diag-exim/) (rodando no
servidor Exim, não no painel) lê:

| Fonte | O que contém | O que NÃO contém |
|---|---|---|
| `exim -bp` / `exiqgrep` (fila) | Remetente, destinatário, tamanho, idade e ID de cada mensagem na fila | **Corpo ou assunto da mensagem** — nunca lido (`-Mvh` mostra só o header/envelope, o script nunca chama `-Mvb`, que mostraria o corpo) |
| Mainlog do Exim | Linhas de log: timestamp, endereços de envelope (from/to), IP de origem, resultado (entregue/rejeitado/deferido), usuário autenticado quando aplicável | Conteúdo da mensagem — o mainlog do próprio Exim nunca grava isso |
| DNS (via `openssl`/consultas DNSBL) | Se o IP de saída está listado em blocklists públicas; registros SPF/DKIM/DMARC do domínio; validade do certificado TLS (STARTTLS, porta 25) | — |
| `sudoers`/binários locais (CSF, Imunify360, cPanel) | Status de bloqueio de IP, versão do Exim, presença de certos pacotes | Nada além do que os próprios binários já expõem via linha de comando |

Nenhuma dessas leituras grava nada no disco do servidor monitorado por
padrão — a única exceção é a **quarentena**: antes de qualquer remoção
de mensagem (`-Mrm`), o script copia os arquivos do spool (`-H`/`-D`/`-J`
— que incluem envelope e corpo da mensagem, porque é literalmente uma
cópia do arquivo do Exim) para
`/var/spool/exim_quarantine/<incidente>/`, **no próprio servidor
monitorado**, nunca transmitida ao painel. Retenção: 7 dias por padrão
(`EXIM_QUARANTINE_RETENTION_DAYS`), depois purgada em definitivo pelo
próprio script (`expire-quarantine`, chamado periodicamente pelo
coletor do painel).

## O que fica armazenado no painel (Postgres)

O backend nunca copia mensagens inteiras — só os campos que os
detectores/relatórios realmente precisam, extraídos do que foi lido
acima:

| Tabela | O que guarda | Dado potencialmente pessoal |
|---|---|---|
| `snapshots` | Contadores agregados por coleta (total na fila, entregues/rejeitados/deferidos) + o JSON bruto retornado pelo script naquele ciclo | O JSON bruto pode conter endereços de remetente/destinatário nos campos de top-sender/top-domínio |
| `incidents` | Tipo, severidade, métricas do detector, `evidence.lines` (linhas reais do mainlog que sustentam o diagnóstico), `impact` (mensagens/contas/domínios afetados) | Sim — `evidence` e `impact.accounts_affected`/`domains_affected` guardam endereços de e-mail reais, deliberadamente (é a evidência que justifica o diagnóstico e o "porquê" no relatório de incidente) |
| `action_history` | Quem executou o quê, quando, resultado, `before_snapshot` (amostra de IDs afetados) | Endereços de e-mail podem aparecer em `param` (ex.: `clean-sender:fulano@dominio.com`) |
| `alert_history` | Canal, severidade, problema — não o conteúdo da mensagem de alerta em si | Baixo |
| `servers.ssh_secret` | Senha SSH ou chave privada, **criptografada em repouso** (Fernet/AES, chave derivada de `SSH_ENCRYPTION_KEY` no `.env` do seu próprio painel — nunca commitada, nunca sai da sua instalação) | Credencial, não dado de cliente — mas sensível |

## Retenção — o que é automático hoje e o que não é

Seja preciso aqui, não otimista:

- **`snapshots`**: purga automática — linhas `quick` com mais de 7 dias
  são removidas; qualquer snapshot (quick ou full) com mais de 90 dias
  é removido. Roda 1x/dia (`retention_loop`, `backend/app/main.py`).
- **Quarentena** (no servidor monitorado, não no painel): purga
  automática após `EXIM_QUARANTINE_RETENTION_DAYS` (7 dias por
  padrão), reforçada pelo próprio `diag-exim.sh` a cada ciclo do
  coletor.
- **`incidents`/`action_history`/`alert_history`**: **sem purga
  automática hoje** — ficam indefinidamente, por design (são o
  histórico/auditoria que os relatórios mensais e a tela de Triagem
  dependem existir por mais que 90 dias). Se você precisa de uma
  política de retenção específica para esses dados (ex.: por contrato
  com seus clientes), hoje isso é manual — apagar direto no Postgres
  ou pedir uma rotina dedicada. O comentário no modelo `AlertHistory`
  menciona "retenção: 90 dias" — **isso não é reforçado por código
  nenhum atualmente**, é uma intenção documentada que ainda não virou
  `run_retention()`. Não repita essa afirmação como se fosse verdade
  operacional sem checar `backend/app/database.py::run_retention()`
  primeiro.

## O que nunca é lido, nem transmitido, nem persistido

- Corpo ou assunto de mensagens (só o header/envelope, nunca `-Mvb`).
- Senhas de conta de e-mail dos remetentes/destinatários (o Exim não as
  expõe pra nada disso; a única senha em jogo é a credencial SSH do
  próprio servidor, fornecida por você).
- Qualquer coisa por uma rede que não seja: SSH do painel para os seus
  servidores Exim, e (se você configurar) e-mail/Telegram/webhook de
  saída para os destinos de alerta que você mesmo escolheu.

## Se você precisa demonstrar isso pra um cliente ou auditor

Este documento + [`docs/seguranca.md`](seguranca.md) (o que o painel
executa remotamente, com que privilégio) + o próprio código (é
self-hosted — você pode ler tudo) são a resposta completa. Não existe
um "servidor da Mail IQ" que guarda cópia de nada — a pergunta "onde
estão os dados dos meus clientes" tem uma resposta de uma frase: no seu
próprio Postgres, na sua própria instalação.
