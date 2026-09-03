# Suporte do Mail IQ

Este documento descreve como o suporte ao painel funciona. Ele integra o
[contrato de licença](../EULA.md) (seção 6).

## O modelo, sem rodeio

O suporte é prestado **por melhor esforço**, em horário comercial
(dias úteis), **sem prazo de resposta garantido**. Não há SLA.

Isso é deliberado: a operação hoje é enxuta, e prometer um número que não
se cumpre é pior do que não prometer. Um SLA pode ser contratado à parte
quando fizer sentido para os dois lados — apertar depois é fácil, afrouxar
depois queima a relação.

Na prática, incidentes que **derrubam o monitoramento** (o painel fora do
ar, o coletor parado, uma atualização que não subiu) têm prioridade sobre
dúvidas de uso e pedidos de melhoria.

## Antes de abrir um chamado

O painel foi feito para responder sozinho a maior parte do que o suporte
perguntaria. Antes de escrever:

1. **Confira a versão e o estado do coletor.** Rodapé do painel (versão) e
   `GET /api/status/collector` (coletor e watchdog). O watchdog religa o
   coletor sozinho e alerta pelos canais configurados quando ele para —
   se você recebeu um alerta de "coleta retomada", provavelmente já
   resolveu.

2. **Veja o histórico.** Configurações → Histórico registra toda ação
   executada, com quem, quando e o resultado real — inclusive tentativas
   negadas e falhas.

3. **Gere o pacote de diagnóstico.** É o próximo item.

## O pacote de diagnóstico

Configurações → Manutenção → **Baixar pacote**. Um arquivo com o estado do
painel — versão, coletor, watchdog, licença, servidores, canais de alerta
e incidentes recentes com a evidência. Anexe-o ao chamado.

**O que o pacote não contém**, nunca: senha nenhuma, chave de
criptografia, token de bot, credencial de e-mail, nem os segredos SSH dos
servidores monitorados (nem cifrados). As partes locais dos endereços de
e-mail em linhas de log viram pseudônimos (`conta#a1b2c3`); os domínios
são mantidos, porque são o que diagnostica problemas de entrega.

O botão **"Ver o conteúdo antes"** mostra o arquivo exato na tela. É texto
legível — confira antes de enviar.

### Quando o painel está fora do ar

Se o painel não sobe, ele não consegue gerar o próprio diagnóstico. Nesse
caso, na máquina onde o painel roda, dentro da pasta de instalação:

```bash
./diagnostic.sh
```

Isso empacota o que o painel não enxerga de si mesmo: containers,
logs de cada serviço, disco, memória, versão do Docker, portas e
certificado. O `.env` **não** entra — só a lista de variáveis definidas,
sem os valores.

## O que informar no chamado

- O que você esperava que acontecesse, e o que aconteceu.
- Quando começou, e se algo mudou antes disso (atualização, mudança no
  servidor monitorado, no DNS, no firewall).
- O servidor afetado, se for um só.
- O pacote de diagnóstico anexado.

## O que está no escopo

- O painel: instalação, atualização, backup/restore, o coletor, o motor
  de incidentes, os alertas, os relatórios, a licença.
- A conexão SSH do painel aos servidores monitorados — do lado do painel.
- O comportamento do `diag-exim.sh` nos ambientes suportados
  (Debian/Ubuntu com `exim4`, cPanel/WHM).

## O que está fora do escopo

- Administração dos servidores Exim em si — configuração do MTA, DNS,
  reputação de IP, políticas anti-spam. O painel **reporta** esses
  problemas e sugere ações; operá-los é do time do cliente.
- Decisões de destino: um provedor que recusa ou atrasa entregas, uma
  blocklist que lista o IP. O painel mostra; a tratativa com o destino é
  do cliente.
- Consequências de uma ação que foi confirmada após o preview. O painel
  mostra exatamente o que faria antes de fazer — a decisão de aplicar é
  de quem clica. Ver a seção 5 e 7 do [contrato](../EULA.md).
- Ambientes não suportados (Plesk, DirectAdmin, MTAs que não sejam Exim).

## A rede de segurança

Nada do que o painel executa é irreversível de imediato:

- **Toda remoção passa por quarentena.** Configurações → Manutenção lista
  os itens em quarentena de qualquer ação, com restauração de um clique,
  por 7 dias (configurável) antes de a remoção virar definitiva.
- **Todo bloqueio de IP é temporário**, com expiração automática (padrão
  4 horas). O painel nunca reinicia o firewall do servidor.
- **Toda ação exige um preview** e um identificador de uso único válido
  por 5 minutos.

Se algo foi aplicado por engano e ainda está dentro dessas janelas, a
reversão é self-service — não precisa abrir chamado.

## Como chegar até nós

[CANAL DE SUPORTE — e-mail / formulário / etc. a definir]

Retorno em horário comercial, por ordem de prioridade e chegada.
