# Segurança — o que o Mail IQ pede no seu servidor

Este documento existe para você auditar **antes** de instalar. Ele lista, com
justificativa, exatamente o que o usuário `mailiq` (criado por
`mailiq-bootstrap.sh`) pode fazer no seu servidor — nada além disso.

Modelo: self-hosted. O compose roda na sua infraestrutura, as chaves SSH e os
logs nunca saem dela. O painel nunca precisa da sua senha de root.

## O usuário `mailiq`

- Usuário de sistema dedicado, sem senha, login por chave SSH apenas
  (`ssh-keygen -t ed25519`, gerada pelo painel no cadastro do servidor).
- Sem shell de login interativo necessário (`nologin` é suficiente) — tudo
  que o Mail IQ faz é executar `diag-exim.sh` via SSH, nunca uma sessão
  interativa.
- Dois grupos, ambos só de **leitura**:
  - `adm` (Debian/Ubuntu) — leitura do mainlog (`/var/log/exim4/mainlog`),
    sem precisar de sudo pra isso.
  - O grupo dono do processo Exim (`Debian-exim` em Debian/Ubuntu; varia em
    cPanel/WHM — o bootstrap detecta automaticamente) — leitura da fila
    (`exim -bp`, `exiqgrep`) e dos arquivos de spool (necessário pra copiar
    mensagens pra quarentena antes de remover — ver abaixo).
- Tudo que **modifica** algo (remover mensagem, bloquear IP, escrever
  blacklist) passa por `sudo`, nunca por permissão de grupo — o grupo só
  cobre leitura.

## `/etc/sudoers.d/mailiq` — referência completa

Este é o conteúdo exato que `mailiq-bootstrap.sh` escreve (ajustando o
caminho dos binários pro que for detectado no seu servidor — `exim4` vs
`exim`, `/usr/sbin` vs outro `PATH`). Nenhum comando fora desta lista roda
como root através do Mail IQ.

```sudoers
# /etc/sudoers.d/mailiq — gerado por mailiq-bootstrap.sh
# NÃO EDITE À MÃO — rode o bootstrap de novo se precisar ajustar caminhos.
Defaults:mailiq !requiretty
Defaults:mailiq secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Fila: remover, ver header, forçar reprocessamento ──────────────────
# cap_remove_messages. Sem isto: clean-full/frozen/bounces/sender/auth e
# retry-queue ficam indisponíveis (painel mostra "modo só-leitura").
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -Mrm *
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -Mvh *
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -qff
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -bp
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -bpc
mailiq ALL=(root) NOPASSWD: /usr/sbin/exim4 -bP *
mailiq ALL=(root) NOPASSWD: /usr/bin/exiqgrep *

# ── Quarentena: copiar mensagem antes/depois de remover ─────────────────
# cap_quarantine. Sem isto, o Mail IQ RECUSA remover mensagens — preserva
# antes de apagar é inegociável (ver Tarefa 3 do AUDITORIA.md). Os
# caminhos são fixos: spool do Exim de um lado, quarentena do Mail IQ do
# outro — nunca um caminho arbitrário.
mailiq ALL=(root) NOPASSWD: /usr/bin/cp -p /var/spool/exim4/input/* /var/spool/exim_quarantine/*
mailiq ALL=(root) NOPASSWD: /usr/bin/cp -p /var/spool/exim_quarantine/*/* /var/spool/exim4/input/*
mailiq ALL=(root) NOPASSWD: /usr/bin/find /var/spool/exim4/input *
mailiq ALL=(root) NOPASSWD: /usr/bin/test -r /var/spool/exim4/input

# ── Bloqueio de IP ────────────────────────────────────────────────────────
# cap_manage_firewall. Sem isto: block-ip fica indisponível. Ordem de
# preferência real do script: CSF > firewalld > iptables cru — seu
# servidor só precisa da que de fato usa (o bootstrap detecta e inclui só
# as relevantes; as três aparecem aqui como referência completa).
mailiq ALL=(root) NOPASSWD: /usr/sbin/csf -td *
mailiq ALL=(root) NOPASSWD: /usr/sbin/csf -tr *
mailiq ALL=(root) NOPASSWD: /usr/sbin/csf -dr *
mailiq ALL=(root) NOPASSWD: /usr/sbin/csf -t
mailiq ALL=(root) NOPASSWD: /usr/sbin/csf -g *
mailiq ALL=(root) NOPASSWD: /usr/bin/firewall-cmd --state
mailiq ALL=(root) NOPASSWD: /usr/bin/firewall-cmd --add-rich-rule=* --timeout=*
mailiq ALL=(root) NOPASSWD: /usr/sbin/iptables -C INPUT -s * -j DROP
mailiq ALL=(root) NOPASSWD: /usr/sbin/iptables -I INPUT -s * -j DROP
mailiq ALL=(root) NOPASSWD: /usr/sbin/iptables -D INPUT -s * -j DROP
mailiq ALL=(root) NOPASSWD: /usr/bin/imunify360-agent ip-list local delete --purpose black *
mailiq ALL=(root) NOPASSWD: /usr/bin/imunify360-agent ip-list local add --purpose white *
mailiq ALL=(root) NOPASSWD: /usr/bin/imunify360-agent ip-list local list --by-ip *

# ── Persistência de bloqueio (só quando cai no fallback iptables) ──────
mailiq ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/firewall.d
mailiq ALL=(root) NOPASSWD: /usr/bin/tee /etc/firewall.d/03_custom
mailiq ALL=(root) NOPASSWD: /usr/bin/tee -a /etc/firewall.d/03_custom
mailiq ALL=(root) NOPASSWD: /usr/bin/tee /etc/firewall.d/03_custom.tmp
mailiq ALL=(root) NOPASSWD: /usr/bin/mv /etc/firewall.d/03_custom.tmp /etc/firewall.d/03_custom
mailiq ALL=(root) NOPASSWD: /usr/bin/chmod 640 /etc/firewall.d/03_custom

# ── Bloqueio de remetente ────────────────────────────────────────────────
# cap_write_blacklist. Sem isto: block-sender fica indisponível.
mailiq ALL=(root) NOPASSWD: /usr/bin/tee -a /etc/exim4/spammer_sender
mailiq ALL=(root) NOPASSWD: /usr/bin/test -w /etc/exim4

# ── Bookkeeping interno (TTL de bloqueio, log de auditoria) ─────────────
# Diretórios de uso exclusivo do Mail IQ — nada aqui toca em arquivo do
# sistema ou de outro serviço.
mailiq ALL=(root) NOPASSWD: /usr/bin/mkdir -p /var/log/exim-monitor
mailiq ALL=(root) NOPASSWD: /usr/bin/chmod 750 /var/log/exim-monitor
mailiq ALL=(root) NOPASSWD: /usr/bin/tee -a /var/log/exim-monitor/actions.log
mailiq ALL=(root) NOPASSWD: /usr/bin/tee /var/log/exim-monitor/ip_blocks.tsv*
mailiq ALL=(root) NOPASSWD: /usr/bin/tee -a /var/log/exim-monitor/ip_blocks.tsv
mailiq ALL=(root) NOPASSWD: /usr/bin/mv /var/log/exim-monitor/ip_blocks.tsv.tmp /var/log/exim-monitor/ip_blocks.tsv
mailiq ALL=(root) NOPASSWD: /usr/bin/grep -c . /var/log/exim-monitor/ip_blocks.tsv
mailiq ALL=(root) NOPASSWD: /usr/bin/mkdir -p /var/spool/exim_quarantine/*
mailiq ALL=(root) NOPASSWD: /usr/bin/chmod 750 /var/spool/exim_quarantine/*
mailiq ALL=(root) NOPASSWD: /usr/bin/rm -f /var/spool/exim_quarantine/*
mailiq ALL=(root) NOPASSWD: /usr/bin/rm -rf /var/spool/exim_quarantine/*
mailiq ALL=(root) NOPASSWD: /usr/bin/find /var/spool/exim_quarantine *
mailiq ALL=(root) NOPASSWD: /usr/bin/cat /var/spool/exim_quarantine/*/manifest.tsv
mailiq ALL=(root) NOPASSWD: /usr/bin/tee /var/spool/exim_quarantine/*/manifest.tsv*
mailiq ALL=(root) NOPASSWD: /usr/bin/tee -a /var/spool/exim_quarantine/*/manifest.tsv
mailiq ALL=(root) NOPASSWD: /usr/bin/awk -F* /var/spool/exim_quarantine/*/manifest.tsv
```

> **Nota sobre wildcards**: `sudoers` casa por padrão glob simples, não é uma
> sandbox — um wildcard `*` num argumento não impede um valor malicioso
> *daquele formato específico*. A defesa real contra isso é a validação de
> entrada que já acontece **antes** de qualquer comando remoto ser montado
> (`_validate_action_param()`/`_sanitize_ip()`/`_sanitize_actor()` no
> backend e no script — ver `AUDITORIA.md`). O sudoers aqui é a segunda
> camada: mesmo que a validação de entrada falhasse, o usuário `mailiq`
> continuaria fisicamente incapaz de rodar qualquer coisa fora desta lista
> — não tem shell de root, não tem `ALL=(ALL) NOPASSWD: ALL`.

## O que isto NÃO concede (de propósito)

- Shell de root, `sudo su`, ou qualquer `ALL=(ALL)` genérico.
- Leitura ou escrita de arquivo fora de `/var/log/exim-monitor/`,
  `/var/spool/exim_quarantine/`, `/etc/firewall.d/03_custom`,
  `/etc/exim4/spammer_sender` e o spool do próprio Exim.
- Instalação/remoção de pacotes, edição de configuração do Exim em si
  (`exim4.conf`), reinício de qualquer serviço (`systemctl restart` não
  aparece em nenhuma regra — ver `AUDITORIA.md` item 2, era assim antes e
  foi removido).
- Acesso a contas de e-mail, caixas de correio, ou qualquer dado fora da
  fila/log do Exim.

## Sondagem de capacidade

Toda vez que o painel testa a conexão com um servidor
(`POST /api/servers/{id}/test`), `diag-exim.sh --check` roda 4 checagens
(`cap_remove_messages`, `cap_manage_firewall`, `cap_write_blacklist`,
`cap_quarantine`) que leem `sudo -n -l` e comparam com o que cada ação
precisa — sem executar nada destrutivo pra testar. O resultado fica salvo
no servidor e o painel desabilita o botão correspondente com o motivo
visível ("este servidor está em modo somente leitura porque falta permissão
para remover mensagens da fila") em vez de deixar a ação falhar em
silêncio. Se `mailiq-bootstrap.sh` não rodou ainda, ou rodou parcialmente,
isso aparece imediatamente — não é preciso esperar uma ação real falhar
pra descobrir.

## Conectar como root (não recomendado)

O painel aceita `ssh_user=root`, mas exige confirmação explícita
(`confirm_root=true`) no cadastro — não é o padrão, e um aviso persistente
("root") fica visível no card do servidor enquanto ele estiver configurado
assim. Use só como último recurso (ex.: primeiro piloto rápido antes do
cliente aprovar rodar o bootstrap) e migre pra `mailiq` assim que possível.
