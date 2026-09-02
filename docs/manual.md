# Manual do painel Mail IQ

Como cada tela funciona e os conceitos por trás delas, na ordem em que
você vai usá-los. Documento voltado a quem opera o painel e atende o
cliente final — não é referência de API nem de instalação (para isso,
ver o [`README.md`](../README.md) e os demais arquivos em `docs/`).

---

## O que é o Mail IQ

Servidores Exim quebram de formas conhecidas: uma conta é comprometida e
passa a disparar spam, o IP de saída entra numa blocklist, a fila trava
porque um destino parou de aceitar mensagens, milhares de devoluções se
acumulam. O trabalho de sempre é o mesmo — perceber, diagnosticar, agir —
e o Mail IQ fecha esse ciclo num lugar só.

1. **Percebe.** Um coletor conecta em cada servidor por SSH e roda um
   script de diagnóstico. Nada é instalado no servidor monitorado — só
   acesso SSH com permissões restritas.
2. **Diagnostica.** Quando um sintoma persiste por vários ciclos, vira um
   **incidente**: título em português, causa, impacto estimado e a
   evidência bruta que sustenta a conclusão.
3. **Age.** Cada incidente tem uma correção sugerida. Você vê um
   *preview* exato do que seria feito antes de confirmar. Toda remoção
   passa por quarentena.
4. **Comunica.** O incidente notifica onde você já está (e-mail,
   Telegram, webhook) e gera um relatório com endereço permanente que
   você encaminha ao cliente final.

### Onde cada peça roda

São duas máquinas com papéis diferentes:

- **O painel** — roda na sua infraestrutura, em Docker. É o que você abre
  no navegador. Guarda o histórico, dispara os alertas, monta os
  relatórios. Suas chaves SSH e os logs dos servidores nunca saem daí.
- **Cada servidor monitorado** — recebe apenas um usuário SSH dedicado
  (`mailiq`, sem senha, só chave) e o script de diagnóstico. O painel
  executa comandos remotos por esse canal; a allowlist exata está em
  [`docs/seguranca.md`](seguranca.md).

---

## Entrar e se orientar

### Login

Acesse a URL do painel e entre com usuário e senha. A sessão dura 8
horas. Dois papéis: **Admin** configura servidores, alertas e usuários e
executa ações; **Viewer** vê tudo mas não altera nada. Convites saem de
Configurações → Usuários.

### O seletor de servidor

No topo do painel há um seletor com todos os servidores cadastrados mais
a opção **Toda a frota**. Ele define o *escopo* de tudo que você vê:
escolha um servidor e cada tela mostra só ele; escolha "Toda a frota" e
as telas agregam o conjunto. O escopo fica gravado no endereço da página
— um link colado no chat leva o servidor certo junto.

### O indicador de coleta

No cabeçalho, ao lado do nome do servidor, fica o indicador de frescor da
coleta. O painel se atualiza sozinho — **verificação leve a cada 30
segundos**, **diagnóstico completo a cada 5 minutos** — e esse indicador
diz se isso está acontecendo:

- **Check verde** — "coletando · atualizado há Xs". A última coleta foi
  bem-sucedida e recente.
- **Alerta vermelho** — a conexão SSH está com erro, ou faz mais de 15
  minutos que nenhuma coleta terminou. O que está na tela pode estar
  velho. Passe o mouse para ver a hora exata da última coleta e a falha.

Na visão "Toda a frota", o indicador mostra a coleta mais atrasada do
conjunto e fica vermelho se qualquer servidor parou.

---

## As seções do painel

A barra lateral tem seis destinos. A **Triagem** é a tela inicial de
propósito — ninguém abre um painel de e-mail quando está tudo bem.

| Seção | Para quê |
|---|---|
| **Triagem** | A fila de incidentes ativos. Lista à esquerda, detalhe no meio, evidência à direita. É aqui que você resolve as coisas. |
| **Frota** | Um cartão por servidor: estado, fila atual, quando foi a última coleta. |
| **Métricas** | Volume de fila e taxa de entrega ao longo das horas, funil de entrega, maiores ofensores do momento, recursos do Exim e visualizador de log. |
| **Plano de correção** | O mesmo fluxo de correção da Triagem, apresentado como um plano por incidente — com etapas, linha do tempo e histórico dos planos encerrados. |
| **Reputação** | Estado de blocklists, SPF/DKIM/DMARC e certificado TLS por servidor, com histórico de entrada e saída de cada lista. |
| **Configurações** | Licença, alertas, servidores, usuários, histórico de auditoria e manutenção. Só Admin. |

O painel clássico de fila ainda existe, agora como a aba **Fila** —
gráficos históricos e atalhos extras aparecem quando o "modo avançado" é
ligado em Configurações → Geral.

---

## Triagem

Três colunas, sempre visíveis ao mesmo tempo:

- **Lista** — os incidentes no escopo atual. Filtros por estado (*Ativos*
  por padrão, ou *Todos*) e por severidade. Se você abre um link direto
  para um incidente já resolvido, o filtro cede para mostrá-lo em vez de
  uma lista vazia.
- **Detalhe** — título do incidente em português, severidade e estado,
  "por que isto virou incidente", métricas, impacto estimado e a correção
  sugerida.
- **Evidência** — a prova bruta, sempre ao lado, nunca atrás de uma aba.
  É o que deixa um sysadmin confiar no diagnóstico em vez de tratar o
  painel como caixa-preta.

### Severidade

Uma escala, duas palavras, em toda a interface:

- **Crítico** — precisa de ação agora.
- **Atenção** — fora do padrão, acompanhe.

### Ações de estado

No detalhe de um incidente aberto:

| Botão | Tecla | O que faz |
|---|---|---|
| Confirmar ciência | — | Registra que alguém viu o incidente. Não muda o estado; fica no histórico com seu nome. |
| Silenciar por 60min | `S` | Para as notificações desse incidente por uma hora. Ele continua aberto e visível. |
| Resolver | `E` | Fecha o incidente manualmente. Se o sintoma voltar, um novo incidente abre. |

Para navegar a lista sem o mouse: `J` desce, `K` sobe. As teclas ficam
inativas enquanto você digita num campo.

---

## Como um incidente nasce e morre

O Mail IQ não abre incidente na primeira leitura ruim. Um sintoma precisa
**persistir por vários ciclos seguidos** antes de virar incidente — é o
que impede que uma consulta DNS que falhou uma vez, ou um pico de fila de
30 segundos, vire um alarme. A mesma histerese vale na saída: o incidente
só é dado como resolvido depois de várias leituras limpas em sequência.

| Estado | O que significa |
|---|---|
| **Aberto** | O sintoma foi confirmado em leituras seguidas. Notifica. |
| **Em observação** | Parou de ser detectado, mas ainda dentro da janela de confirmação. Está esfriando, não confirmado. |
| **Mitigado** | A correção sugerida foi aplicada. Se ela não segurar, o incidente volta para "Aberto". |
| **Resolvido** | Várias leituras limpas seguidas (fechado automaticamente) ou você fechou à mão. |

Só a abertura e o **agravamento** de um incidente geram notificação. "Em
observação" e "resolvido automaticamente" não avisam. E um incidente
resolvido não reabre pela mesma causa dentro de uma janela curta de
proteção: se o mesmo problema voltar em minutos, ele agrava o incidente
recente em vez de criar um novo.

Quando a verificação de um incidente para de responder (o servidor ficou
inacessível, por exemplo), o painel diz isso explicitamente: ele continua
aberto porque não há como confirmar que terminou, não porque foi
confirmado de novo.

---

## Os quatro tipos de incidente

| Tipo | O que é | Título típico |
|---|---|---|
| **Conta comprometida** | Uma conta autenticou de muitos IPs diferentes, ou disparou um volume muito acima do normal dela. O padrão de cada conta é aprendido ao longo do tempo — o alerta é relativo a ela, não a um número fixo. | "Conta joao@dominio.com autenticou de 14 IPs diferentes" |
| **Reputação de entrega** | O IP de saída apareceu numa blocklist pública (Spamhaus ZEN, SpamCop, SORBS, Barracuda); ou faltam registros SPF / DKIM / DMARC no domínio; ou o certificado TLS está perto de vencer (aviso a partir de 15 dias) ou já venceu. | "IP 190.x.x.x listado na Spamhaus ZEN" |
| **Fila travada** | A fila ficou parada acima de um limite por vários ciclos; ou o número de mensagens *congeladas* (que não saem sozinhas) cresceu e se manteve alto. | "Fila parada em 1.240 mensagens" |
| **Adiamento por destino** | Um domínio de destino está adiando uma fatia grande das suas entregas — o destino está recusando ou atrasando, não o seu servidor. | "gmail.com adiando 38% das entregas" |

O bloco "por que isto virou incidente", no detalhe, sempre traduz o
gatilho em uma frase: o que foi observado, e a partir de que limite o
alerta dispara. O limite é ajustável ali mesmo, no botão ao lado.

---

## A evidência

Cada tipo de incidente carrega a prova adequada a ele — nunca um genérico
"linhas de log" para tudo:

| Tipo | Evidência mostrada |
|---|---|
| Conta comprometida / Fila travada / Adiamento por destino | Linhas reais do `mainlog` relacionadas à entidade — a conta, o domínio, as mensagens. Cada linha é copiável. |
| Reputação — blocklist | A zona consultada, a resposta bruta do DNS, qual resolver respondeu, o horário e o histórico das últimas checagens. |
| Reputação — SPF/DKIM/DMARC | Os registros DNS conferidos, e quais estão faltando. |
| Reputação — certificado | A cadeia, o emissor, a validade e o hostname usado na verificação. |

A evidência é **congelada no momento em que o incidente abre** (e
recalculada quando ele agrava). Se a evidência de log vier vazia — o que
acontece num servidor com dezenas de milhares de envios por ciclo, onde
uma mensagem em *backoff* só registra a cada nova tentativa — o painel
mostra linhas recentes do tipo certo como contexto e diz que fez isso.

---

## Corrigir um incidente

Toda ação — na Triagem, no Plano de correção ou na aba Fila — segue o
mesmo caminho. Nada é executado no servidor antes de você ver o preview.

1. **Escolha a ação.** A correção sugerida já vem selecionada no detalhe
   do incidente. Você também pode abrir o catálogo completo de ações.
2. **Preencha o parâmetro**, se houver (o e-mail do remetente, o IP a
   bloquear) e, para ações destrutivas, marque se quer capturar o estado
   do servidor antes.
3. **"Ver plano".** O painel roda a fase `plan()` no servidor: ela lê e
   simula, mas **não altera nada**. Volta com exatamente o que seria
   feito — quantas mensagens, quais IDs, qual regra de firewall.
4. **"Aplicar agora".** Só aqui algo muda. O backend só executa com o
   identificador de uso único emitido pelo plano, válido por 5 minutos.
   Passou disso, você planeja de novo.
5. **Verificação.** Depois de agir, o painel reconsulta a fila. Se sobrou
   mensagem que não deu para remover, ele diz isso — com os IDs — em vez
   de reportar "concluído".

O botão final nunca diz um "Aplicar" genérico. Ele diz o que de fato
acontece: **Enviar para quarentena**, **Bloquear IP**, **Reprocessar
fila**.

### Quando o botão está desabilitado

Se um servidor não tem a permissão necessária para uma ação (não roda
CSF, o usuário `mailiq` não pode escrever na blacklist, etc.), o botão
nasce desabilitado com o motivo escrito — você não descobre a falta de
permissão só depois de clicar. Essas capacidades são sondadas no teste de
conexão do servidor.

---

## Catálogo de ações

Dois níveis. **Segura** não remove nem corta nada. **Destrutiva** remove
mensagens ou corta tráfego — sempre com preview e, por padrão, com
quarentena.

| Ação | Nível | O que faz | Exige |
|---|---|---|---|
| Reprocessar fila | Segura | Força o Exim a tentar entregar a fila de novo agora, sem esperar o próximo ciclo de retry. | — |
| Remover mensagens congeladas | Destrutiva | Manda para a quarentena as mensagens marcadas como *frozen* — as que o Exim já desistiu de entregar sozinho. | remover mensagens + quarentena |
| Remover devoluções | Destrutiva | Quarentena as mensagens de devolução (bounces) acumuladas na fila. | remover mensagens + quarentena |
| Remover de um remetente | Destrutiva | Quarentena tudo que estiver na fila vindo de um endereço remetente específico. | remover mensagens + quarentena |
| Limpar fila de uma conta | Destrutiva | Quarentena tudo na fila associado a uma conta autenticada — o alvo típico de uma conta comprometida. | remover mensagens + quarentena |
| Bloquear IP | Destrutiva | Bloqueio temporário de um IP (padrão 4 horas), usando CSF, firewalld ou iptables — a primeira que existir no servidor. Expira sozinho. | gerenciar firewall |
| Bloquear remetente | Destrutiva | Adiciona o endereço à blacklist de remetentes do Exim no servidor. | escrever na blacklist |

**"Limpar toda a fila"** — a única ação de escopo total — não fica aqui.
Ela mora em Configurações → Manutenção, atrás de um preview real e da
exigência de digitar o nome exato do servidor.

---

## Quarentena e reversão

O Mail IQ nunca apaga uma mensagem direto. Antes de qualquer remoção, os
arquivos da mensagem são **copiados** para uma área de quarentena no
próprio servidor. De lá:

- **Restauração de um clique** por 7 dias — a mensagem volta para a fila
  do Exim exatamente como estava.
- Depois de 7 dias (configurável), a quarentena é purgada e a remoção
  vira definitiva.

Os itens em quarentena ativos aparecem em Configurações → Manutenção, de
qualquer ação que os tenha gerado, com o prazo de expiração de cada um.

Bloqueios de IP seguem lógica parecida: sempre temporários, sempre com
expiração automática. O painel nunca reinicia o firewall do servidor.

---

## Frota

Um cartão por servidor. Cada cartão mostra:

- **Estado** — Crítico, Atenção, Normal ou Não verificado — e o motivo em
  uma linha. É a mesma avaliação que a Triagem usa para aquele servidor;
  as duas nunca divergem.
- **Fila atual** e há quanto tempo foi a última coleta.

Filtro por estado no topo. Clicar num cartão abre a Triagem já com aquele
servidor no escopo. "Não verificado" não é erro — é um servidor que ainda
não teve um ciclo de diagnóstico completo, ou cuja checagem não respondeu
neste ciclo (e o painel exige três leituras indefinidas seguidas antes de
rotular assim, para não piscar).

---

## Métricas

A série é **por servidor**. Com mais de um servidor cadastrado e nenhum
selecionado, a tela pede que você escolha um — somar servidores
diferentes no mesmo instante sem agregação seria um gráfico enganoso.

- **Cartões de resumo (KPIs)** — enviadas no período, adiadas,
  rejeitadas, pico de fila.
- **Volume da fila** — mensagens acumuladas ao longo do período, com o
  pico marcado.
- **Funil de entrega** — onde o e-mail se perde, não só a taxa final. Das
  mensagens *enviadas*, quantas foram entregues, adiadas e rejeitadas.
- **Throughput de envio** — mensagens processadas por ciclo.
- **Maiores ofensores do momento** — maior remetente, maior destinatário,
  domínio de destino que mais recebe, conta que mais autentica. É onde um
  abuso aparece antes de virar incidente.
- **Recursos do Exim** (recolhido por padrão) — processos, CPU e memória
  do Exim, uptime, versão, tamanho do `mainlog`, percentual de
  reconhecimento do log, mensagens grandes na fila.
- **Log Viewer** — visualizador do `mainlog` embutido, com o servidor do
  escopo aplicado e filtro por tipo de linha. A exportação leva período,
  conta e formato (CSV ou TXT).

---

## Reputação

As checagens de reputação rodam sozinhas a cada ciclo completo do
coletor — não é um botão que você aperta. Esta tela é o estado atual e o
histórico, por servidor:

- **DNSBL (blocklist)** — Spamhaus ZEN, SpamCop, SORBS, Barracuda. Verde
  se limpo, vermelho com a zona se listado.
- **SPF / DKIM / DMARC** — presença dos registros de autenticação no
  domínio.
- **Certificado TLS** — validade do certificado usado no STARTTLS.

Abaixo de cada servidor, o **histórico**: cada entrada e saída de
blocklist com data. É o que você usa para responder "desde quando" e "por
quanto tempo" quando um cliente pergunta sobre a reputação do IP.

---

## Plano de correção

É o fluxo de correção da Triagem, apresentado como um plano. Duas
colunas: à esquerda, todos os incidentes ativos da frota mais um atalho
para o histórico; à direita, o plano completo do selecionado, com:

- Banner do incidente, causa raiz e impacto — em português, sem o nome
  interno da regra.
- Um **stepper** com os quatro estados reais do incidente (Aberto → Em
  observação → Mitigado → Resolvido) como as quatro etapas.
- A linha do tempo do incidente: cada mudança de estado, com quem fez e
  quando.
- As mesmas opções de correção do catálogo de ações, com o mesmo preview.

`/plano/historico` abre a lista de planos já encerrados.

---

## Configurações → Geral: a licença

O primeiro bloco de **Configurações → Geral** mostra o estado da licença
desta instalação (só Admin): cliente, identificador da licença, até quando
vale, quantos dias faltam e quantos servidores estão em uso do total
contratado.

A licença é conferida **no próprio servidor**, sem consultar a internet. O
painel não fala com nenhum servidor de licenciamento e não envia dado
nenhum para fora — funciona igual numa rede fechada.

### O que acontece quando a licença vence

Quase nada, de propósito. Uma licença vencida, inválida ou ausente:

- **não** desliga o painel;
- **não** o deixa somente-leitura;
- **não** interrompe a coleta dos servidores já cadastrados;
- **não** apaga, esconde nem degrada dado nenhum.

O único efeito é que o botão **Adicionar servidor** fica desabilitado, com
o motivo no tooltip, e a API recusa o cadastro de servidores novos. Tudo o
que já está monitorado continua exatamente como estava.

Uma faixa no topo do painel avisa quando algo precisa de atenção: âmbar
quando ainda dá tempo (vence em até 14 dias, ou a instalação está em
cortesia), vermelha quando já venceu ou o token não confere. No estado
normal a faixa não aparece.

### Instalação sem licença

Uma instalação nova sem licença configurada entra em **cortesia**: 1
servidor por 30 dias, contados da instalação. É o suficiente para rodar um
piloto antes de existir contrato. Terminada a cortesia, vale a mesma regra
de sempre — o que já está cadastrado continua sendo monitorado, e só o
cadastro de servidores novos fica suspenso.

### Instalar ou renovar a licença

A licença é um token que vai na variável `MAILIQ_LICENSE`, no `.env` do
painel. Depois de editar o arquivo:

```bash
docker compose up -d backend
```

`up -d` e não `restart`: o `restart` reaproveita o container existente e
**não relê o `.env`** — a licença nova seria ignorada em silêncio, e o
painel continuaria mostrando o estado antigo.

O estado novo aparece em Configurações → Geral e no log do backend. Se o
token não for aceito, a tela diz o motivo.

---

## Configurações → Alertas

Três canais, cada um com teste de envio próprio:

- **E-mail** — via Resend (API key) ou SMTP próprio (host, porta,
  usuário, senha, STARTTLS). Define destinatário e remetente.
- **Telegram** — bot token do `@BotFather` e chat ID. Serve para grupo ou
  conversa direta.
- **Webhook** — um POST em JSON (severidade, problema, servidor,
  timestamp) a cada alerta. Secret opcional assina o payload em
  HMAC-SHA256.

### Frota versus servidor

Cada canal é configurado **uma vez na frota** e herdado por todos os
servidores. Um servidor só passa a ter configuração própria de um canal
quando você liga o *override* — "Usar a configuração deste canal para
toda a frota" desmarcado. Sem servidor selecionado no seletor, você edita
a configuração da frota; com um servidor selecionado, edita (ou cria) o
override dele.

### Condições de disparo

| Ajuste | Efeito |
|---|---|
| Severidade mínima | *Apenas crítico* ou *Crítico e atenção*. Define o que é ruído e o que é alerta. |
| Alerta se a fila ultrapassar | Dispara mesmo que a severidade ainda não tenha mudado. `0` desativa. |
| Cooldown entre alertas | Minutos de silêncio para o mesmo evento, para evitar flood de notificação. |

### Custo estimado (opcional)

Custo médio por hora de sysadmin e por ticket de suporte. Alimenta o
cálculo de tempo e dinheiro poupados que aparece no relatório de
incidente.

### Histórico de alertas

Toda notificação enviada — canal, evento, servidor, sucesso ou falha.
Respeita o escopo do seletor.

---

## Configurações → Servidores

Cadastro e gerência dos servidores monitorados (só Admin). Ao adicionar
um servidor você informa host, porta, usuário SSH e a chave. O botão
**Testar conexão** roda uma bateria de checagens e mostra o resultado de
cada uma:

- Binário do Exim, `exiqgrep`, espaço em disco, leitura do `mainlog`.
- Ambiente cPanel/WHM, firewall CSF, Imunify360.
- Relay aberto, STARTTLS, versão do Exim (contra CVEs conhecidos).
- Capacidades de ação — se aquele servidor pode remover mensagens,
  gerenciar firewall, escrever na blacklist, quarentenar. É o que
  habilita ou desabilita cada botão no catálogo de ações.

O estado da conexão de cada servidor (Online, Erro SSH, Timeout, Erro de
credencial) aparece aqui e como um ponto colorido no seletor do
cabeçalho.

---

## Configurações → Usuários

Convide por e-mail ou gere um link de convite com validade. Dois papéis:

- **Admin** — tudo: configura servidores, alertas e usuários; planeja e
  aplica ações; acessa o histórico de auditoria e a manutenção.
- **Viewer** — vê todas as telas e a evidência, mas não altera
  configuração nem executa nenhuma ação.

---

## Configurações → Histórico

A auditoria de tudo que foi executado em cada servidor — sem precisar
entrar por SSH para ler um arquivo de log. Cada linha traz:

- Quem, quando, qual plano, e o **resultado real** (não "concluído"
  genérico).
- O estado do servidor *antes* da ação, quando foi capturado.
- Tentativas negadas e falhas de conexão também — não só o que deu certo.

Exportável em CSV e JSON, por servidor e por período.

---

## Configurações → Manutenção

Duas coisas moram aqui porque são pesadas demais para o fluxo normal:

- **Limpar toda a fila** — a única ação que atinge a fila inteira, sem
  filtro. Mesmo preview, mesmo identificador de 5 minutos, mesma
  quarentena das outras ações — mas o "Aplicar" só libera depois que você
  **digita o nome exato do servidor**.
- **Quarentena ativa** — todos os itens em quarentena de qualquer ação,
  com restauração de um clique e o prazo de expiração de cada um.

---

## Notificações e relatório

Quando um incidente abre ou agrava, a notificação sai pelos canais
configurados com um link no formato `/incidents/INC-1234`. Clicar nele
abre a Triagem já naquele incidente — mesmo que ele já tenha sido
resolvido entre o alerta e o clique.

### O relatório do incidente

Do detalhe de qualquer incidente, "Ver relatório →" abre uma página com
**endereço permanente** (`/incidents/{id}/report`): dá para voltar,
salvar nos favoritos, imprimir. E há um **link de leitura público com
validade** — para o cliente final, que não tem conta no painel, receber o
relatório sem você precisar dar acesso a nada.

---

## O que o Mail IQ garante

Não só o que ele executa — o que ele se recusa a fazer:

- **Nunca apaga direto.** Toda remoção passa por quarentena, com
  restauração de um clique por 7 dias antes de virar definitiva.
- **Nunca reinicia o firewall.** Bloqueio de IP prefere a ferramenta
  nativa (CSF, firewalld), que expira sozinha, e só cai para `iptables`
  cru como último recurso — sempre com prazo, nunca com `systemctl
  restart`.
- **Nunca finge sucesso.** Toda ação reconsulta a fila depois de agir. Se
  sobraram mensagens, o painel diz exatamente isso, com os IDs.
- **Nunca age sem plano.** Toda ação passa por uma fase que mostra o que
  faria sem alterar nada, antes de um "aplicar" liberado por um
  identificador de uso único válido por 5 minutos.
- **Nunca pede a senha de root.** Um usuário SSH dedicado, sem senha, só
  com chave, recebe exatamente a lista de comandos necessária via
  `/etc/sudoers.d/mailiq` — nada além.
- **Nunca finge que o log é normal.** Se o formato do log não é
  reconhecido, o servidor é marcado como degradado — nunca "0 mensagens"
  como se estivesse tudo bem.

A allowlist completa de comandos SSH, comentada para auditoria, está em
[`docs/seguranca.md`](seguranca.md). Matriz de compatibilidade de
ambientes em [`docs/compatibilidade.md`](compatibilidade.md).

---

## Perguntas frequentes

**Por quanto tempo os dados na tela ficam válidos?**
Verificação leve a cada 30 segundos, diagnóstico completo a cada 5
minutos. O indicador de coleta no cabeçalho fica vermelho se passar de 15
minutos sem uma coleta bem-sucedida, ou se a conexão SSH cair.

**Apliquei uma correção por engano. Dá para voltar?**
Se foi remoção de mensagens: sim, em Configurações → Manutenção, enquanto
o item estiver na quarentena (7 dias). Se foi bloqueio de IP: ele expira
sozinho, ou você desbloqueia pela ação de desbloqueio. Tudo fica no
Histórico com instruções de reversão.

**Um Viewer pode quebrar alguma coisa?**
Não. Viewer não executa ações nem altera configuração. Só Admin planeja e
aplica.

**O incidente sumiu da lista. Foi resolvido?**
O filtro padrão é "Ativos". Troque para "Todos" para ver os resolvidos,
ou abra o link direto do incidente — o filtro cede para mostrá-lo.

**Cadastrei o servidor e ele está "Não verificado".**
Espere um ciclo de diagnóstico completo (até 5 minutos). Se persistir,
rode "Testar conexão" em Configurações → Servidores e veja qual checagem
falhou.

**Posso monitorar servidores que não são cPanel?**
Sim — Debian/Ubuntu com `exim4` e cPanel/WHM são suportados. Plesk e
DirectAdmin são trabalho futuro.
