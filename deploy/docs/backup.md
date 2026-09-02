# Backup e restauração

## O que é um backup do Mail IQ

Um tarball (`backups/AAAAMMDD-HHMMSS.mailiq-backup.tar.gz`) com três
arquivos:

| | |
|---|---|
| `db.sql` | dump completo do Postgres (servidores, incidentes, histórico, alertas, snapshots) |
| `env` | cópia do `.env` — inclui a **`SSH_ENCRYPTION_KEY`** |
| `MANIFEST` | data, versão do Mail IQ, versão do schema, tamanho do dump |

O `db.sql` guarda as credenciais SSH dos servidores **cifradas**. Só a
`SSH_ENCRYPTION_KEY` do `env` as decifra. Por isso o backup carrega os
dois juntos — e por isso ele é sensível: **quem tem o arquivo tem acesso
aos servidores monitorados**. `chmod 600` é aplicado; copie para fora
deste servidor (outro host, cofre, storage cifrado).

## Fazer backup

```bash
cd deploy
./backup.sh
```

Não pede nada, não para o painel. O `upgrade.sh` roda `./backup.sh`
sozinho antes de atualizar.

Agende no cron (exemplo, 3h da manhã):

```cron
0 3 * * *  cd /caminho/para/deploy && ./backup.sh >> backup.log 2>&1
```

Faça a rotação você mesmo (ex.: `find backups -name '*.tar.gz' -mtime +30 -delete`).

## Restaurar

```bash
cd deploy
./restore.sh backups/20260902-030000.mailiq-backup.tar.gz
```

O `restore.sh`:

1. **Valida a chave** — confere que a `SSH_ENCRYPTION_KEY` do backup
   realmente decifra os segredos do dump. Se não decifra, **aborta sem
   tocar em nada** (restaurar assim deixaria todos os servidores
   indecifráveis). Se o dump não tem servidores, avisa e pede confirmação.
2. Pede a confirmação `restaurar`.
3. Tira um snapshot do estado atual (outro backup) antes de destruir.
4. Para o backend, recria o banco, aplica o dump.
5. Injeta **só a `SSH_ENCRYPTION_KEY`** do backup no `.env` atual — é o
   que precisa casar com o dump. `POSTGRES_PASSWORD`, `DOMAIN` e a versão
   continuam os desta máquina. O `.env` anterior fica em
   `.env.pre-restore-*`; o `.env` completo do backup, em `.env.from-backup-*`.
6. Sobe a stack e espera o `/api/health`.

O volume do Caddy é preservado — o certificado TLS não é reemitido.

## Migrar o painel para outro servidor

1. No servidor antigo: `./backup.sh`, copie o tarball.
2. No servidor novo: instale o Docker, clone/coloque o `deploy/`,
   `docker login ghcr.io`, e rode `./install.sh` normalmente (gera um
   `.env` novo com `POSTGRES_PASSWORD`/`DOMAIN` desta máquina).
3. `./restore.sh <tarball>` — traz os dados e a `SSH_ENCRYPTION_KEY` do
   backup; mantém a senha do banco e o domínio do servidor novo.
4. Aponte o DNS do domínio para o servidor novo.
