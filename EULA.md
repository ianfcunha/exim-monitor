# Contrato de Licença de Uso de Software — Mail IQ

> **Minuta para revisão jurídica.** Este documento foi redigido para
> cobrir o essencial da primeira venda — concessão de licença, limitação
> de responsabilidade, suporte e dados. **Ele não substitui a revisão de
> um advogado** antes de ser usado como instrumento contratual, em
> especial as cláusulas de limitação de responsabilidade (seção 7) e de
> tratamento de dados (seção 8). Marcadores entre colchetes
> `[ASSIM]` devem ser preenchidos antes da assinatura.

---

## Partes

**LICENCIANTE:** [RAZÃO SOCIAL DA AVILI], inscrita no CNPJ sob o nº
[CNPJ], com sede em [ENDEREÇO], doravante "AVILI".

**LICENCIADA:** a pessoa jurídica identificada no pedido de licença, na
proposta comercial aceita ou no instrumento de contratação que
incorpora este contrato, doravante "Cliente".

Ao instalar, executar ou continuar a utilizar o Mail IQ, o Cliente
declara ter lido e aceito integralmente os termos abaixo.

---

## 1. Definições

- **Software** ou **Mail IQ**: o painel de gestão operacional para
  servidores de e-mail Exim desenvolvido pela AVILI — backend, frontend,
  agregação de frota, motor de incidentes, histórico, alertas e
  relatórios —, distribuído como imagens de contêiner e/ou código-fonte,
  **exceto** o diretório `diag-exim/`, que possui licença própria (MIT) e
  não é regido por este contrato.
- **Servidor Monitorado**: cada servidor Exim que o Cliente conecta ao
  Software para diagnóstico e execução de ações.
- **Licença de Uso** ou **Token**: o valor assinado fornecido pela AVILI
  para a variável `MAILIQ_LICENSE`, que identifica o Cliente, o número
  contratado de Servidores Monitorados e a data de expiração.
- **Ação**: qualquer operação que o Software execute sobre um Servidor
  Monitorado e que altere seu estado — remoção ou movimentação de
  mensagens da fila, bloqueio de IP ou de remetente, reprocessamento de
  fila, entre outras.
- **Plano**: a fase de simulação que precede toda Ação, na qual o
  Software consulta o Servidor Monitorado e relata o que a Ação faria,
  sem alterar nada.

## 2. Objeto

A AVILI concede ao Cliente uma licença de uso do Software, não exclusiva,
intransferível e limitada, nos termos deste contrato e do pedido de
licença correspondente. O Software é **proprietário**: este contrato não
transfere ao Cliente qualquer direito de propriedade intelectual sobre o
Software, seu código-fonte ou sua documentação.

## 3. Concessão de licença

3.1. O Cliente pode instalar e executar o Software em infraestrutura
própria (servidor, VPS ou nuvem sob seu controle), para uso operacional
interno, monitorando até o número de Servidores Monitorados indicado na
Licença de Uso.

3.2. A avaliação do Software com o objetivo de decidir pela contratação é
permitida, ainda que sem Licença de Uso, pelo período de cortesia
descrito na seção 4.

3.3. É vedado ao Cliente, salvo autorização escrita da AVILI:

  a) copiar, modificar, mesclar, publicar, distribuir, sublicenciar,
     alugar, emprestar ou vender o Software;
  b) usar o Software para prestar a terceiros serviço hospedado ou
     gerenciado concorrente ao da AVILI;
  c) remover, ocultar ou alterar avisos de titularidade, e
  d) realizar engenharia reversa com finalidade distinta da
     interoperabilidade permitida em lei.

3.4. A licença do diretório `diag-exim/` é a MIT, constante de
`diag-exim/LICENSE`, e permanece válida de forma autônoma, inclusive após
o término deste contrato.

## 4. Licença de Uso e período de cortesia

4.1. O Software verifica a Licença de Uso **localmente**, contra uma
chave pública nele embutida. O Software **não se comunica com nenhum
servidor de licenciamento** e não transmite dado algum para a AVILI em
razão dessa verificação. A verificação funciona em rede fechada.

4.2. Licença de Uso **expirada, inválida ou ausente não interrompe a
operação**: o Software continua monitorando os Servidores Monitorados já
cadastrados, mantém o painel plenamente acessível e não apaga, oculta nem
degrada nenhum dado. A **única** consequência é a suspensão do cadastro
de **novos** Servidores Monitorados até a regularização.

4.3. Uma instalação sem Licença de Uso opera em **cortesia**: 1 (um)
Servidor Monitorado por 30 (trinta) dias contados da instalação, para
fins de avaliação. Encerrada a cortesia, aplica-se a regra da cláusula
4.2.

4.4. A renovação ou ampliação da Licença de Uso depende de acordo
comercial entre as partes.

## 5. Responsabilidades do Cliente

5.1. O Cliente é o único responsável por:

  a) prover e proteger as credenciais SSH de acesso aos Servidores
     Monitorados e a chave de criptografia (`SSH_ENCRYPTION_KEY`) da sua
     instalação;
  b) manter cópias de segurança do banco de dados do painel e do
     respectivo arquivo `.env` — sem este, as cópias do banco são
     inúteis (ver `deploy/backup.sh`);
  c) **revisar o Plano de cada Ação antes de confirmá-la**, e
  d) decidir se e quando executar cada Ação, à luz do Plano apresentado.

5.2. O Software apresenta o Plano de toda Ação antes de qualquer
alteração e exige confirmação explícita para aplicá-la. A quarentena de
mensagens e a expiração automática de bloqueios são **mecanismos de
mitigação, não garantias**: o Cliente reconhece que operações sobre
sistemas de e-mail em produção envolvem risco inerente.

5.3. O Cliente declara ter autorização para conectar ao Software cada
Servidor Monitorado e para executar Ações sobre ele.

## 6. Suporte

6.1. O suporte ao Software é prestado por **melhor esforço**, em horário
comercial, **sem prazo de resposta garantido (sem SLA)**, salvo acordo
escrito em contrário. Os canais, o escopo e o procedimento estão
descritos em `docs/suporte.md`, que integra este contrato.

6.2. Correções, melhorias e novas versões são disponibilizadas a
critério da AVILI enquanto vigente a Licença de Uso. A atualização é
responsabilidade do Cliente (ver `deploy/upgrade.sh`).

## 7. Garantias e limitação de responsabilidade

7.1. O Software é fornecido **"no estado em que se encontra"** ("as is"),
sem garantias de qualquer natureza, expressas ou implícitas, incluindo,
sem limitação, garantias de adequação a uma finalidade específica, de
funcionamento ininterrupto ou livre de erros, e de que os diagnósticos
ou Ações produzirão determinado resultado.

7.2. A AVILI **não se responsabiliza** por:

  a) consequências de Ações confirmadas pelo Cliente após a
     apresentação do Plano correspondente;
  b) perda, atraso, bloqueio ou não entrega de mensagens de e-mail,
     ainda que decorrentes de Ação executada pelo Software;
  c) indisponibilidade dos Servidores Monitorados, do provedor de
     hospedagem ou da infraestrutura onde o Cliente executa o Software;
  d) danos decorrentes de credenciais comprometidas, chave de
     criptografia perdida ou cópias de segurança inexistentes;
  e) reputação de IP ou de domínio, listagem em blocklists e decisões de
     provedores de destino, que o Software apenas reporta.

7.3. Em nenhuma hipótese a responsabilidade total da AVILI, por qualquer
causa relacionada a este contrato, excederá o valor efetivamente pago
pelo Cliente à AVILI pela Licença de Uso nos 12 (doze) meses anteriores
ao evento que originou a reclamação. A AVILI não responde por lucros
cessantes, perda de dados, perda de negócios ou danos indiretos.

7.4. As limitações desta seção são condição essencial do preço praticado
e permanecem válidas ainda que qualquer remédio previsto neste contrato
falhe em seu propósito essencial.

## 8. Dados e privacidade

8.1. **A AVILI não opera infraestrutura que receba dados do Cliente.** O
Software é executado pelo Cliente, na infraestrutura do Cliente, e se
conecta aos Servidores Monitorados com credenciais do Cliente. Logs,
endereços de e-mail e credenciais **não trafegam para a AVILI** em
operação normal. O detalhamento do que o Software lê, armazena e por
quanto tempo está em `docs/dados.md`, que integra este contrato.

8.2. Para efeito da Lei nº 13.709/2018 (LGPD), os dados pessoais
eventualmente contidos nos e-mails processados pelos Servidores
Monitorados pertencem à relação entre o Cliente e os titulares desses
dados. Ao adotar a arquitetura self-hosted, **a AVILI não é introduzida
como operadora** desses dados.

8.3. **Pacote de diagnóstico.** O Software permite ao Cliente gerar, sob
demanda, um pacote de diagnóstico para envio ao suporte. Esse pacote:

  a) **não** contém senhas, chaves de criptografia, tokens ou as
     credenciais SSH dos Servidores Monitorados;
  b) tem as **partes locais** dos endereços de e-mail substituídas por
     pseudônimos irreversíveis (os domínios são mantidos, por serem
     necessários ao diagnóstico e por não identificarem pessoa natural);
  c) só é transmitido à AVILI **por ato do próprio Cliente** — o
     Software não o envia automaticamente.

O Cliente pode visualizar o conteúdo integral do pacote antes de
enviá-lo. Ao enviá-lo, o Cliente autoriza a AVILI a utilizá-lo
exclusivamente para a prestação do suporte.

## 9. Vigência e rescisão

9.1. Este contrato vigora enquanto o Cliente utilizar o Software e,
quanto às obrigações que por sua natureza subsistem (seções 3.3, 7 e 8),
mesmo após o término.

9.2. Qualquer das partes pode rescindir mediante comunicação escrita. Em
caso de rescisão, o Cliente deve cessar o uso do Software; os dados na
instalação do Cliente permanecem sob controle exclusivo do Cliente, que é
responsável por sua exportação ou eliminação.

9.3. O descumprimento das vedações da cláusula 3.3 autoriza a rescisão
imediata pela AVILI, sem prejuízo das medidas cabíveis.

## 10. Disposições gerais

10.1. Este contrato, o pedido de licença, `docs/suporte.md` e
`docs/dados.md` constituem o acordo integral entre as partes quanto ao
seu objeto e prevalecem sobre entendimentos anteriores.

10.2. A tolerância quanto a qualquer descumprimento não implica novação
nem renúncia.

10.3. A nulidade de uma cláusula não afeta as demais.

10.4. Este contrato é regido pela **lei brasileira**. Fica eleito o
**foro da comarca da sede do Cliente** para dirimir controvérsias, com
renúncia a qualquer outro por mais privilegiado que seja.

---

_Versão da minuta: 2026-09-03. Ao ser adotada como instrumento
contratual, esta minuta deve receber data, número de versão e a revisão
jurídica referida no topo do documento._
