# Atualizar o Mail IQ

## Como

```bash
cd deploy
./upgrade.sh 1.1.0
```

O `upgrade.sh`, em ordem:

1. **Backup** — roda `./backup.sh` (dump do banco + `.env`). Se o
   `backup.sh` não estiver no diretório, ele pede confirmação para
   seguir sem rede de segurança.
2. **Troca a versão** — reescreve `MAILIQ_VERSION` no `.env` e guarda a
   cópia anterior em `.env.bak-<versão-antiga>`.
3. **`docker compose pull` + `up -d`** — puxa e sobe as imagens novas.
4. **Verificação de saúde** — espera `/api/version` reportar a versão
   alvo e `/api/health` responder `ok` (até ~2 min).
5. **Rollback automático** — se qualquer passo acima falhar, volta o
   `.env`, puxa e sobe a versão anterior.

Sempre leia o `CHANGELOG.md` do release antes de atualizar.

## O que o rollback cobre — e o que não cobre

O rollback automático volta a **imagem** (o código). Se a versão nova
chegou a subir e **rodou migrations de banco** antes de falhar, o schema
do banco pode ter mudado, e a imagem antiga não roda contra um schema
mais novo. Nesse caso:

```bash
./restore.sh <arquivo-de-backup-do-passo-1>
```

O caminho do backup aparece no início da saída do `upgrade.sh`.

## Pular versões

Pode ir direto de `1.0.0` para `1.3.0` — as migrations são aplicadas em
sequência no boot. Ainda assim, em saltos grandes, vale atualizar em
degraus e conferir o painel entre eles.

## O `.env`

Fica só nesta máquina. Contém `SSH_ENCRYPTION_KEY`, a chave Fernet que
decifra as credenciais SSH de todos os servidores cadastrados — **sem
ela, um backup do banco é inútil**. O `backup.sh` empacota o `.env`
junto; guarde os backups fora deste servidor.

Nunca troque `SSH_ENCRYPTION_KEY` nem `POSTGRES_PASSWORD` num painel já
em uso: a primeira torna os servidores indecifráveis, a segunda quebra o
acesso ao banco já inicializado.

## Limpeza

Depois de confirmar que a versão nova está estável, remova os arquivos
`.env.bak-*` e os backups antigos que não quiser mais guardar.
