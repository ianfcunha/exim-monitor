# diag-exim.sh

Diagnóstico inteligente de fila e log para servidores Exim — um único
script bash, sem dependências além do que qualquer servidor Exim já
tem instalado (`awk`, `grep`, `openssl` para os checks de TLS/DNSBL).
Funciona sozinho, sem instalar nada, sem conta em lugar nenhum, sem
enviar dado pra fora do seu servidor.

Este diretório é um pacote independente dentro do repositório do
[Mail IQ](https://github.com/ianfcunha/exim-monitor) — o painel que
opera uma frota de servidores Exim a partir daqui. Você não precisa do
painel pra usar este script: ele foi desenhado desde o início pra
rodar sozinho, direto no terminal de qualquer sysadmin.

## Licença

MIT — ver [`LICENSE`](LICENSE). Uso, modificação e redistribuição
livres, inclusive comercial. Esta é a única parte do Mail IQ sob
licença permissiva; o painel (backend, frontend, agregação de frota,
histórico, alertas, relatórios) é software comercial à parte — ver o
[README principal](../README.md#licenciamento) pra entender a fronteira.

## Compatibilidade

Debian/Ubuntu (`exim4`) e cPanel/WHM. Outros painéis (Plesk,
DirectAdmin) não são suportados hoje — ver
[`../docs/compatibilidade.md`](../docs/compatibilidade.md) pra a
matriz completa de formatos de log validados vs. inferidos.

## Uso rápido

```bash
curl -O https://raw.githubusercontent.com/ianfcunha/exim-monitor/official/diag-exim/diag-exim.sh
chmod +x diag-exim.sh
./diag-exim.sh              # menu interativo — colorido, com detalhe por remetente/domínio
./diag-exim.sh --json       # coleta completa, saída em JSON
./diag-exim.sh --quick      # heartbeat leve (pula exim -bp/exiqgrep — rápido o bastante pra rodar a cada 30s)
./diag-exim.sh --check      # verifica pré-requisitos do servidor (binários, permissões, cPanel/CSF/Imunify360...)
```

Rode como root, ou como um usuário com permissão de leitura no spool e
no mainlog do Exim — o script se adapta ao que consegue ler/fazer e
reporta explicitamente quando alguma verificação exige privilégio que
falta, em vez de fingir sucesso.

## Ações

`--action=<comando>` executa uma ação isolada e devolve um JSON com o
resultado — pensado tanto pra uso manual (cron, alerta, script próprio)
quanto para integração com qualquer painel, o Mail IQ ou não:

| Ação | O que faz |
|---|---|
| `clean-full` / `clean-frozen` / `clean-bounces` | Remove mensagens da fila (toda / congeladas / bounces) |
| `clean-sender:<endereço>` / `clean-auth:<usuário>` | Remove mensagens de um remetente ou conta autenticada específica |
| `block-ip:<ip>` / `block-sender:<endereço>` | Bloqueia no firewall (CSF → firewalld → iptables, nesta ordem) ou na blacklist do Exim |
| `retry-queue` | Força reprocessamento da fila |
| `check-deliverability[:domínio]` | DNSBL + SPF/DKIM/DMARC + expiração do certificado TLS — só leitura |
| `check-ip-status --ip=<ip>` / `unblock-ip --ip=<ip> --tool=csf\|imunify360\|iptables` | Consulta/reverte bloqueio de IP |
| `list-blocks` / `expire-blocks` | Lista/expira bloqueios com TTL vencido |
| `restore-quarantine:<id>` / `list-quarantine` / `expire-quarantine` | Restaura, lista ou purga mensagens quarentenadas |

Toda ação destrutiva quarentena a mensagem (copia o spool) antes de
remover — reversível por padrão, retenção configurável
(`EXIM_QUARANTINE_RETENTION_DAYS`, 7 dias por padrão). `--dry-run=1`
mostra exatamente o que uma ação faria, sem alterar nada — a mesma
consulta que a execução real usaria, não uma simulação separada que
pode divergir.

Lista completa de flags e variáveis de ambiente configuráveis
(`EXIM_TH_*`, `EXIM_CSF_BIN`, `EXIM_SUSPICIOUS_TLDS`...) no cabeçalho
do próprio script — é a fonte de verdade, sempre atualizada junto do
código.

## Contribuindo

Pull requests para este script são bem-vindos — abra um PR contra
`diag-exim/diag-exim.sh` no repositório principal. Mudanças no restante
do Mail IQ (painel) seguem um processo à parte.
