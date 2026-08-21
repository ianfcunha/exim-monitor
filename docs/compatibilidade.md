# Compatibilidade — formatos de log suportados

O Mail IQ diagnostica a fila lendo o `mainlog` do Exim direto do servidor.
Este documento diz, com evidência, quais formatos foram validados de
verdade e quais são inferidos — a Tarefa 6 (Sessão 1, pós-auditoria)
existe justamente para o painel nunca fingir "tudo normal" quando não
consegue ler um log.

## Como a taxa de reconhecimento funciona

Toda coleta calcula `log.lines_total` / `log.lines_recognized` /
`log.recognition_pct` — a fração das linhas amostradas que começam com o
timestamp no formato padrão do Exim (`YYYY-MM-DD HH:MM:SS`, a config
`log_timestamp` do próprio Exim, ligada por padrão em toda instalação).
Abaixo de 80% de reconhecimento (configurável via
`EXIM_LOG_MIN_RECOGNITION_PCT`), o servidor é classificado como
`DEGRADED` / `LOG_NAO_RECONHECIDO` e as métricas de entrega/rejeição
deixam de ser exibidas como se fossem confiáveis — ver `AUDITORIA.md`
item 6.

Isto é depois de aprender, testando ao vivo, que exigir *message-id* em
toda linha reconhecida dava falso positivo: linhas administrativas
100% normais do Exim (`Start queue run: pid=...`, `End queue run:
pid=...`) não têm message-id, e em um servidor pouco movimentado elas
dominam a amostra — um log perfeitamente legível caiu pra 67% de
reconhecimento na primeira versão deste critério. O critério final
(timestamp no formato certo, sem exigir message-id) ainda rejeita um
formato genuinamente diferente — ver `tests/fixtures/unknown_format.log`.

## Matriz de compatibilidade

| Ambiente | Formato de log | Status | Evidência |
|---|---|---|---|
| Debian/Ubuntu, Exim4 padrão do pacote (`log_timestamp` default) | `YYYY-MM-DD HH:MM:SS <flag> <detalhes>` em `/var/log/exim4/mainlog` (+ `.1`, `.1.gz`) | **Validado ao vivo** | `tests/fixtures/debian_exim4_normal.log` — capturado de um Exim4 real rodando neste ambiente de desenvolvimento (linhas administrativas e de entrega reais; as duas linhas de rejeição/deferimento foram escritas à mão no formato real do Exim, para cobrir cenários que não ocorreram organicamente durante o teste — sinalizado explicitamente aqui, não é uma captura 100% orgânica) |
| cPanel/WHM, Exim gerenciado pelo WHM | Mesmo formato de linha (cPanel roda Exim de fábrica, não um fork) em `/var/log/exim_mainlog`, rotação `exim_mainlog-YYYYMMDD.gz` | **Inferido, não validado ao vivo** | O script já trata o padrão de rotação datada do cPanel (`_read_log_lines()`, `LOG_CANDIDATES`) desde antes desta sessão, mas nenhuma sessão até agora teve acesso a um ambiente cPanel real para confirmar o formato de linha em si. Como o cPanel não modifica o binário do Exim, a expectativa é que o formato seja idêntico ao padrão — mas isso é inferência, não evidência direta. |
| RHEL/CentOS/AlmaLinux, Exim via EPEL | Mesmo binário Exim, caminho de log tipicamente `/var/log/exim/mainlog` (já na lista de `LOG_CANDIDATES`) | **Não testado** | Caminho já coberto na lista de candidatos; formato de linha não confirmado contra uma instalação real. |
| Qualquer ambiente com log encaminhado via syslog/rsyslog/journald (prefixo `Mon DD HH:MM:SS host processo[pid]:`) | Formato syslog, timestamp não-ISO no início da linha | **Rejeitado de propósito** | `tests/fixtures/unknown_format.log` — o timestamp do Exim fica no MEIO da linha, não no início; `LOG_LINES_RECOGNIZED` corretamente reconhece 0% e o servidor é marcado `DEGRADED`, não `NORMAL`. Se um piloto real usar isso, o log precisa ser reconfigurado para escrever direto em arquivo (`log_file_path` no `exim.conf`), não redirecionado a syslog. |

## O que fazer se um servidor cair em `DEGRADED`/`LOG_NAO_RECONHECIDO`

1. Conferir `log.lines_total` no JSON — se for 0, o mainlog não foi
   encontrado nos caminhos de `LOG_CANDIDATES` (`diag-exim.sh`) ou o
   usuário `mailiq` não tem permissão de leitura (grupo `adm`/dono do
   log — ver `docs/seguranca.md`).
2. Se `lines_total` > 0 mas `recognition_pct` < 80%, o log existe e é
   legível, mas o formato das linhas é diferente do esperado — rodar
   `diag-exim.sh --check` e olhar o check `mainlog`, e comparar uma
   amostra real do log contra `tests/fixtures/debian_exim4_normal.log`.
3. Reportar o formato encontrado — vira uma nova linha nesta matriz e,
   se for genuinamente um formato diferente (não um problema de
   permissão/caminho), um ajuste no padrão de `LOG_LINES_RECOGNIZED`
   (`diag-exim.sh`, dentro de `analyze_log()`).

## Fixtures e teste de regressão

`tests/fixtures/*.log` são consumidos por `tests/test_log_recognition.sh`,
que prova o critério de aceite da Tarefa 6: um log de formato desconhecido
tem que resultar em `DEGRADED`/`LOG_NAO_RECONHECIDO`, nunca em `NORMAL`
nem em contadores zerados apresentados como se fossem a fila real.
