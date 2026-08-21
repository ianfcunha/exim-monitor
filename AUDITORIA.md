# AUDITORIA.md — Mail IQ, o que hoje impede instalar num host de terceiro

Escopo: só o que bloqueia ou torna arriscado instalar em servidores de produção que
não conheço, controlados por terceiros. Nenhuma mudança de código nesta tarefa.

---

## 1. Como as credenciais SSH são armazenadas?

- **Algoritmo**: Fernet (AES-128-CBC + HMAC-SHA256, simétrico) — `backend/app/crypto.py:16,39-54`.
  `encrypt_secret()`/`decrypt_secret()` cifram/decifram a senha SSH **ou** o conteúdo
  da chave privada (o campo é genérico, guarda um dos dois conforme `ssh_auth_type`).
- **Onde fica a chave de criptografia**: `SSH_ENCRYPTION_KEY`, uma env var lida em
  `backend/app/config.py:39` (`settings.ssh_encryption_key`), setada em
  `backend/.env`. **Mesmo arquivo `.env` guarda a chave de criptografia e o segredo
  cifrado** — quem tem acesso de leitura ao `backend/.env` (ou ao volume Docker que
  o monta) descriptografa qualquer segredo SSH salvo no banco. Não há separação
  entre "quem guarda a chave" e "quem guarda o cofre" (ex.: KMS externo, HSM,
  segundo segredo). Aceitável para uma primeira versão self-hosted, mas é o único
  ponto de falha: vazar `backend/.env` = vazar acesso SSH a todos os servidores
  cadastrados.
- **Está em arquivo versionado?** Não. `.gitignore:13-14` (`.env` / `!.env.example`)
  exclui `.env` do git; confirmado com `git ls-files | grep env` → só
  `backend/.env.example` está rastreado, com placeholders (`TROQUE-ME-EM-PRODUCAO...`).
  O `backend/.env` real, presente neste host, tem segredos gerados (chave Fernet,
  senha do Postgres, JWT secret, senha admin) — nunca foi commitado, mas **está em
  texto puro no disco do host que roda o backend**, sem cofre de sistema (nenhum
  `chmod 600` explícito, nenhuma integração com secret manager). Isso é esperado no
  modelo self-hosted (o cliente controla a própria infra), mas deve constar em
  `docs/seguranca.md` como responsabilidade do cliente proteger o filesystem do
  host onde o compose roda.
- Persistência no banco: `backend/app/database.py:89` — `ssh_secret = Column(String(4000), default="", nullable=False)`,
  guardado por servidor (`Server.owner_id` como FK para o dono), nunca em texto
  puro — só o valor já-cifrado.
- **Falha silenciosa perigosa**: `decrypt_secret()` (`crypto.py:46-54`) retorna
  `""` em vez de lançar exceção se `InvalidToken` (chave trocada ou dado corrompido)
  — só loga um erro. Um `SSH_ENCRYPTION_KEY` diferente do que cifrou o segredo (ex.:
  restaurar um backup de banco num host novo sem restaurar o `.env` junto) faz o
  sistema tentar conectar com senha/chave vazia, não avisa o operador do motivo real
  da falha de conexão.

## 2. Comandos exatos executados no servidor remoto

Dois canais distintos: (A) o backend chama `diag-exim.sh` via SSH com flags — o
script então roda dezenas de comandos locais nele mesmo; (B) o backend roda alguns
comandos ad-hoc direto via `_run_raw()`, sem passar pelo script.

### A. Invocação do script (`backend/app/ssh.py:151-154`)
```
bash <script_path> <args>
```
onde `<args>` é um dos:
- `--quick` — heartbeat leve (`ssh.py:270-272`)
- `--json` — coleta completa (`ssh.py:275-277`)
- `--check` — autodiagnóstico de pré-requisitos (`ssh.py:316-323`)
- `--action=<ação>[:<param>] [--actor=<user>] [--snapshot=0]` — ações (`ssh.py:293-313`)
- `--action=check-ip-status --ip=<ip>` (`ssh.py:338-346`)
- `--action=unblock-ip --ip=<ip> --tool=csf|imunify360 [--actor=<user>]` (`ssh.py:349-366`)

Deploy do script em si (não é execução, é upload): `deploy_script()`
(`ssh.py:208-248`) — SFTP `put()` de `diag-exim.sh` local para
`server_cfg["script_path"]`, seguido de `chmod 0o755`. Disparado a cada
`POST /api/servers` (`routers/servers.py:122-136`, "melhor esforço").

### B. Comandos ad-hoc via `_run_raw` (fora do script)
- `for f in <candidatos de mainlog>; do [ -f "$f" ] && tail -N "$f" && break; done` — `get_log_tail()` (`ssh.py:501-524`)
- `exim -bp 2>/dev/null | head -1000` — `get_queue_items()` (`ssh.py:527-530`)
- `for f in <candidatos>; do [ -f "$f" ] && grep -E '<padrão>' "$f" | tail -N && break; done` — `get_log_entries()` (`ssh.py:533-554`)
- Varredura multi-arquivo (ativo + `.1`/`.1.gz` + rotação datada `cPanel`, com `cat`/`zcat`, `grep -E`, `grep -F`, `tail`) — `get_log_entries_ranged()` (`ssh.py:570-663`), usada por `GET /api/messages/export`

Nenhum desses comandos ad-hoc é destrutivo — são leitura (`tail`/`grep`/`cat`/`zcat`)
ou consulta de fila (`exim -bp`, que só lista).

### C. Dentro do script — ações destrutivas (`--action=`, `diag-exim.sh:1586-1855`, função `execute_action()`)

| Ação | Comando(s) reais no servidor | Reversível? |
|---|---|---|
| `clean-full` | `exim -bp \| awk '{print $3}' \| grep -E '^[A-Za-z0-9-]{6,}$'` para listar IDs, depois `xargs -P4 $EXIM_BIN -Mrm` em cada um | **Não** — `-Mrm` apaga a mensagem do spool |
| `clean-frozen` | `exiqgrep -z -i` (lista frozen) → `xargs -P4 $EXIM_BIN -Mrm` | **Não** |
| `clean-bounces` | `$SUDO exiqgrep -f '<>' -i` → `xargs -P4 $EXIM_BIN -Mrm` | **Não** |
| `clean-sender:<addr>` | `$SUDO exiqgrep -f "$param" -i` → `xargs -P4 $EXIM_BIN -Mrm` | **Não** |
| `clean-auth:<user>` | para até 500 IDs: `$EXIM_BIN -Mvh <id> \| grep auth_id` para achar match, depois `xargs $EXIM_BIN -Mrm` nos que baterem | **Não** |
| `block-ip:<ip>` | `$SUDO iptables -I INPUT -s <ip> -j DROP` **imediato**, mais persistência via `_block_ip_persist()` (abaixo) | Parcialmente — remove a regra manualmente, sem TTL/expiração automática hoje |
| `block-sender:<addr>` | `printf '%s\n' "$param" \| $SUDO tee -a /etc/exim4/spammer_sender` | Reversível manualmente (editar o arquivo), sem UI de "desbloquear" hoje |
| `retry-queue` | `$EXIM_BIN -qff` (força retry de toda a fila, inclusive frozen) | Não destrutivo, mas pode reenviar/reprocessar em massa sem preview |
| `check-deliverability[:domínio]` | Só leitura: `check_blacklists_json` (consultas DNS a DNSBLs), `check_deliverability_json` (SPF/DKIM/DMARC via `dig`/`host`), `check_cert_json` (`openssl s_client -starttls smtp -connect host:25`) | N/A — não altera nada |
| `check-ip-status --ip=<ip>` | Só leitura: `csf -g <ip>`, `csf -t` (lista temporários), `imunify360-agent ip-list local list --by-ip <ip> --json`, leitura de log do MagicSpam | N/A |
| `unblock-ip --ip=<ip> --tool=csf` | `$SUDO csf -tr <ip>` (se temporário) ou `$SUDO csf -dr <ip>` (se permanente) | Reversível (é o próprio unblock) |
| `unblock-ip --ip=<ip> --tool=imunify360` | `$SUDO imunify360-agent ip-list local add --purpose white <ip> --comment "..."` — **whitelist, não remove da blacklist** | Efetivo mas não é "desfazer" o bloqueio original |

`_block_ip_persist()` (`diag-exim.sh:2382+`): grava a regra em
`/etc/firewall.d/03_custom` via `$SUDO tee`/`tee -a` e roda
`$SUDO systemctl restart firewall.service` para aplicar — reinicia o serviço de
firewall inteiro do host a cada bloqueio de IP.

> **Status: corrigido** (Sessão 1, Tarefa 2) — `_block_ip_persist()` foi
> substituída por `_apply_ip_block()`: nunca mais chama `systemctl restart`.
> Cascata de ferramenta nativa — CSF (`-td`, TTL nativo) → firewalld
> (`--timeout`, TTL nativo) → iptables cru só como último recurso, com TTL
> via bookkeeping próprio (`ip_blocks.tsv` + `--action=expire-blocks`/
> `list-blocks`, chamado periodicamente pelo `collector.py` a cada tick do
> heartbeat). `unblock-ip --tool=imunify360` também corrigido: tentava só
> whitelist, agora tenta remover da blacklist de verdade primeiro. Validado
> ao vivo neste host (sem CSF/firewalld, só iptables): 20 ciclos de
> bloqueio/desbloqueio sem nenhum restart e sem perder a regra; expiração
> automática confirmada com TTL curto. Coberto por
> `tests/test_ip_block.sh`.

Existe uma segunda cópia dessas mesmas ações no **menu interativo** (não usado
pela API, mas presente no mesmo script — roda se alguém rodar `diag-exim.sh` sem
flags direto no servidor): `clean_full()`, `clean_frozen()`, `clean_bounces()`
(`diag-exim.sh:2334-2350`) — mesma lógica, `exim -Mrm` em lote, sem `$SUDO` e sem
sequer usar `$EXIM_BIN` (usa o literal `exim`, quebra em Debian/Ubuntu onde o
binário é `exim4`).

## 3. Quais comandos são irreversíveis?

Estritamente irreversíveis (apagam mensagens de terceiros do spool, sem cópia):
**`clean-full`, `clean-frozen`, `clean-bounces`, `clean-sender`, `clean-auth`**
— todas via `-Mrm`, que remove a mensagem do spool do Exim sem deixar uma cópia
recuperável em lugar nenhum. `before_snapshot` (`diag-exim.sh:1596-1600` e
equivalentes) grava **quantos e quais IDs** existiam antes — é só visibilidade
para auditoria, não um mecanismo de restauração; os `before_snapshot`s são
puramente informativos e não podem reverter a exclusão (confirmado lendo o
comentário em `diag-exim.sh:1563-1571`: "não é undo de verdade").

`block-ip` e `block-sender` são reversíveis **manualmente** (remover a regra
iptables/linha do firewall.d, editar `/etc/exim4/spammer_sender`), mas hoje não
existe endpoint/UI para desfazer nenhum dos dois — nem TTL automático.

`retry-queue` não apaga nada, mas força reprocessamento em massa sem confirmação
nem preview — pode gerar uma onda de reenvio para destinatários que já receberam
via outro caminho, ou reativar mensagens frozen por um bom motivo.

> **Status: corrigido** (Sessão 1, Tarefa 1) — `execute_action()` agora passa
> toda remoção por `_remove_ids_verified()`: `$SUDO`/`$EXIM_BIN` padronizados,
> `-Mrm` id a id (`xargs -n1`), e a fila é reconsultada depois para confirmar
> o que de fato sumiu. `success=true` só quando o delta observado bate com o
> solicitado; caso contrário `success=false` com "permissão negada em X de Y"
> e `leftover_ids`. Coberto por `tests/test_action_verification.sh` (binários
> `exim4`/`exiqgrep` falsos, sem depender de Exim real) e validado ao vivo
> injetando mensagens reais neste host e confirmando a fila esvaziada. A
> segunda cópia da lógica no menu interativo (`clean_full()` etc., mesmo bug,
> mais o literal `exim` que quebra em Debian) ainda está pendente — ver
> Tarefa 5.

**Achado crítico de confiabilidade** (relevante para a Tarefa 2, "ações seguras"):
em `clean-full/frozen/bounces/sender/auth`, o `xargs ... $EXIM_BIN -Mrm` roda
**sem `$SUDO`** (`diag-exim.sh:1603,1614,1625,1646,1669`, e a cópia do menu
interativo em `2343`), enquanto o script só ativa `$SUDO` quando `id -u` não é 0
(`diag-exim.sh:322-326`). Em instalação sem root direto (exatamente o alvo da
Tarefa 1 — usuário `mailiq` de menor privilégio), `-Mrm` roda sem `sudo` e, no
layout padrão do Exim (spool dono `Debian-exim`/`exim`, modo 640), falha
silenciosamente por permissão. **O script não verifica o exit code do `xargs`
nem reconsulta a fila depois** — `output_action_json "true" ...` é emitido de
qualquer forma, com a contagem calculada *antes* da tentativa de remoção. Ou
seja: o painel pode reportar "fila limpa — N mensagens removidas" com N mensagens
ainda intactas na fila. Isso é uma falha de reversibilidade às avessas (finge que
uma ação irreversível aconteceu, quando na verdade não aconteceu nada) — precisa
de correção na Tarefa 1/2, não só sudoers.

## 4. Endpoints que disparam ação remota e verificação de permissão

Modelo de permissão: dois papéis, `admin` e `viewer` (`auth.py:5-9`, `require_admin`
em `auth.py:138-145` rejeita quem não é `admin` com 403). `get_current_user`
(`auth.py:90-135`) só exige JWT válido — qualquer papel passa.

| Endpoint | Ação remota disparada | Guard de permissão |
|---|---|---|
| `POST /api/actions/{action}` | `run_action()` → qualquer ação em `ALLOWED_ACTIONS` (`routers/actions.py:42-52`, inclui todas as destrutivas da tabela acima) | `Depends(require_admin)` (`actions.py:137`) — **correto**, viewer não passa |
| `GET /api/actions/history` | Nenhuma (só lê `ActionHistory` do banco) | `Depends(require_admin)` (`actions.py:219`) — mais restritivo que precisaria (é leitura), mas não é um risco |
| `POST /api/servers` | `deploy_script()` (SFTP, grava/sobrescreve o script no servidor remoto) | `Depends(require_admin)` (`servers.py:101`) — correto |
| `PUT /api/servers/{id}` | Nenhuma execução remota direta, mas troca segredo SSH/host/script_path — muda o alvo de ações futuras | `Depends(require_admin)` (`servers.py:157`) — correto |
| `DELETE /api/servers/{id}` | Nenhuma remota | `Depends(require_admin)` (`servers.py:186`) — correto |
| `POST /api/servers/{id}/test` | `test_connection()` + `run_check()` (leitura) | `Depends(require_admin)` (`servers.py:204`) — mais restritivo que precisaria, sem risco |
| `GET /api/servers/{id}/security/ip-status` | `check_ip_status()` (leitura, `csf -g`/`csf -t`/imunify360 list) | `Depends(require_admin)` (`security.py:55`) |
| `POST /api/servers/{id}/security/unblock` | `unblock_ip()` (`csf -tr/-dr`, `imunify360-agent ... whitelist`) | `Depends(require_admin)` (`security.py:74`) — correto |
| `GET /api/messages/queue`, `/tail`, `/log`, `/export` | Leitura (`get_queue_items`, `get_log_tail`, `get_log_entries[_ranged]`) | `Depends(get_current_user)` — viewer pode ler fila/log/exportar, o que é esperado (são só-leitura) |
| `GET /api/status/quick`, `/full` | Leitura (cache do coletor) | `Depends(get_current_user)` |
| `POST /api/status/refresh` | Força nova coleta completa (`run_full`, só leitura remota) | `Depends(get_current_user)` — **viewer pode disparar isso**; não é destrutivo, mas dispara carga extra no servidor remoto sem ser admin |

**Verificação de posse do servidor**: toda rota parametrizada por `server_id` passa
por `get_server_owned_by(db, server_id, current_user)` (`servers.py`, `actions.py`,
`security.py`) antes de montar `server_cfg` — impede um admin de um tenant agir
sobre o servidor de outro admin (isolamento por `owner_id`/`invited_by`, não é
multi-tenant real ainda, mas já segmenta corretamente hoje).

**Achado**: nenhuma rota de ação tem rate-limit por servidor-alvo, só por IP de
origem (`@limiter.limit("20/minute")` em `actions.py:129`, `security.py:68`) — um
admin comprometido ainda consegue disparar até 20 `clean-full` por minuto contra
o mesmo servidor.

## 5. Onde exatamente o script precisa de root? O que funcionaria sem?

O script já tem uma detecção de privilégio (`diag-exim.sh:321-326`):
```bash
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO=""
fi
```
`$SUDO` é usado em (`grep '\$SUDO' diag-exim.sh`, 17 ocorrências):
- `exim -bP config` (ler config do relay, `check_open_relay`) — precisa de root/grupo Exim pra ler `/etc/exim4/exim4.conf` na maioria dos setups
- criar/chmod `/var/log/exim-monitor` (log de auditoria do próprio script)
- `exiqgrep -f '<>'`, `exiqgrep -f "$param"` (busca por remetente na fila) — listar fila por padrão já não requer root, mas o script pede sudo aqui mesmo assim (não usado de forma consistente — outros `exiqgrep`, como o de `clean-frozen`, rodam sem `$SUDO`)
- `iptables -C`/`-I INPUT ... DROP` (bloqueio de IP) — **requer root de verdade** (`CAP_NET_ADMIN`), sem alternativa
- `csf -g/-t/-tr/-dr`, `imunify360-agent ...` — CSF e Imunify360 exigem root por design (eles mesmos rodam como root)
- gravar em `/etc/exim4/spammer_sender` (`block-sender`) — precisa escrita num diretório tipicamente `root:root`
- gravar/reiniciar `/etc/firewall.d/03_custom` + `systemctl restart firewall.service` (persistência de bloqueio de IP) — precisa root

**O que funciona sem root (comandos que já rodam sem `$SUDO` hoje)**:
- `exim -bp` (listar fila), `exiqgrep -z` (listar frozen), `exim -Mvh` (ler headers)
  — funcionam para o dono do processo Exim ou para quem está no grupo correto
  (`Debian-exim`/`mail`), não precisam necessariamente de root
- Leitura do mainlog (`tail`/`grep`/`cat`/`zcat`) — funciona se o usuário estiver no
  grupo dono do arquivo de log (`adm` em Debian/Ubuntu tipicamente) — **hoje o
  script não testa isso**, só tenta e retorna vazio silenciosamente se não tiver
  permissão (ver item 6)
- Consultas de rede só-leitura: `dig`/`host` (SPF/DKIM/DMARC), `openssl s_client`
  (cert TLS), lookups de DNSBL — não exigem privilégio nenhum
- `exim -qff` (retry-queue) — normalmente requer ser o usuário Exim ou root; não
  passa por `$SUDO` hoje (mesma inconsistência do item 3 acima)
- **`-Mrm` (a remoção em si) — hoje roda sem `$SUDO` em todo lugar**, mas
  *deveria* estar na lista de comandos privilegiados (ver achado crítico no item 3)

**Conclusão para a Tarefa 1**: a allowlist de sudoers precisa cobrir, no mínimo:
`iptables -C/-I INPUT -s <ip> -j DROP`, `csf -g/-t/-tr/-dr <ip>`,
`imunify360-agent ip-list local ...`, escrita em `/etc/exim4/spammer_sender`,
escrita em `/etc/firewall.d/03_custom` + `systemctl restart firewall.service`,
`exim -bP config`, e — corrigindo o bug do item 3 — `exim -Mrm`, `exim -qff`,
`exim -Mvh`, `exiqgrep`. Leitura do mainlog deveria ser resolvida com o usuário
`mailiq` no grupo `adm` (ou equivalente), não via sudoers.

## 6. O que acontece hoje se o parsing do log falhar ou retornar zero linhas?

**Nada visível — o painel mostra "tudo normal".** Não existe hoje nenhum
mecanismo de "não consegui ler este log":

- `analyze_log()` (`diag-exim.sh:790-823`) calcula `REJECT_COUNT`, `DEFER_COUNT`,
  `DELIVERED_COUNT`, `RECENT_SENDS` aplicando `grep -c` com padrões fixos
  (` rejected `, `=>.*T=`, ` <= `, etc.) contra a amostra do log. Se o formato do
  log não bate com nenhum desses padrões (versão de Exim diferente, log de
  outro MTA, log customizado), todos os contadores dão **0**, sem distinção
  entre "0 porque não tem nada acontecendo" e "0 porque não entendi o formato".
- `classify()` (`diag-exim.sh:1100-1102`) começa com
  `PROBLEM="NORMAL"; SEVERITY="OK"` e só sai desse estado se algum contador
  passar de um threshold. Com tudo zerado, cai direto em NORMAL/OK — **é
  literalmente o comportamento que a Tarefa 4 pede pra eliminar**.
- No backend, `_save_snapshot()` (`collector.py:69-94`) e `_collect_server()`
  (`collector.py:150-157`) usam `diag.get("severity", "OK")` e
  `diag.get("problem", "NORMAL")` como default — ou seja, mesmo se o script um
  dia passasse a devolver um JSON sem o campo `diagnosis`, o backend também
  assumiria "OK" por padrão, dobrando o mesmo problema numa segunda camada.
- Não existe hoje nenhum campo no JSON tipo `log_lines_total` /
  `log_lines_recognized` — o script não expõe quantas linhas leu vs. quantas
  entendeu, então nem seria possível calcular a taxa de reconhecimento sem
  instrumentar `analyze_log()` primeiro (é exatamente o que a Tarefa 4 propõe).
- Falha de leitura do arquivo em si (`[ -f "$f" ]` não bate com nenhum candidato
  em `_LOG_CANDIDATES`) também degrada pro mesmo silêncio: nenhuma linha é lida,
  contadores ficam em 0, classifica como NORMAL — o operador não tem como
  distinguir "servidor sem problema" de "não achei o mainlog nesse servidor".

---

## Resumo do que bloqueia hoje um host de terceiro

1. **Só root ou usuário com sudo irrestrito** — não existe usuário dedicado de
   menor privilégio nem allowlist de sudo (Tarefa 1).
2. **Senha de root direto no painel** — `ServerCreate.ssh_user` default `"root"`,
   `ssh_auth_type` default `"password"` (`routers/servers.py:34-35`); `install.sh`
   pergunta o usuário SSH mas aceita `root` como default sem exigir confirmação
   extra (`install.sh:132-133`).
3. **`install.sh` não deploya de fato em host remoto de terceiro** — a
   automação de "gerar chave e copiar para `authorized_keys`" só roda quando
   `SSH_HOST` é o próprio host (mesmo servidor / bridge Docker); para um host
   remoto genuíno, o script só pergunta o caminho de uma chave que **já** precisa
   estar autorizada lá, e a linha `cp "$INSTALL_DIR/diag-exim.sh" "$SCRIPT_DEST"`
   grava **localmente**, não no servidor remoto — quem instala precisa copiar o
   script manualmente (ou confiar no `deploy_script()` via SFTP do backend, que
   também exige que a chave já tenha acesso). Sem bootstrap, terceiro nenhum
   consegue delegar acesso sem primeiro dar SSH root.
4. **Ações destrutivas sem preview/confirmação de duas fases** — `clean-full`
   dispara e já apaga; não há `plan()`/`apply()` (Tarefa 2).
5. **Falso "sucesso" em `-Mrm` sem privilégio suficiente** — reporta remoção
   mesmo quando nada foi removido (achado do item 3).
6. **"Limpar toda a fila" no painel principal, sem dupla confirmação** — ainda
   não verificado no frontend nesta auditoria (fora do escopo de arquivos lidos
   aqui), mas a Tarefa 2 já assume que precisa mover para tela separada.
7. **Sem quarentena/restore, sem TTL de bloqueio, sem auditoria à prova de
   adulteração** — Tarefas 2 e 3.
8. **"Tudo normal" quando o log não é reconhecido** — Tarefa 4.

Nenhuma mudança de código foi feita nesta tarefa — só leitura e este relatório.
