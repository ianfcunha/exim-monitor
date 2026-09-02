# Mail IQ — deploy

Rodar o painel Mail IQ a partir de imagens versionadas (ghcr.io), sem
código-fonte na máquina. Este diretório é autocontido.

```
deploy/
  docker-compose.yml   painel (postgres + backend + frontend + Caddy/HTTPS)
  Caddyfile            reverse proxy + certificado TLS automático
  .env.example         modelo de configuração — copie para .env
  install.sh           instala o painel (1ª vez)
  upgrade.sh           atualiza para uma versão, com rollback automático
  backup.sh            dump do banco + .env, num tarball
  restore.sh           restaura um backup — valida a chave Fernet antes
  check-key.py         validador da chave (usado pelo restore.sh)
  docs/
    instalar.md        passo a passo da instalação e do 1º servidor
    atualizar.md       como atualizar, o que o rollback cobre, onde fica o .env
```

## TL;DR

```bash
cp .env.example .env      # preencha DOMAIN, senhas e segredos
./install.sh              # instala e sobe
./backup.sh               # a qualquer momento — tarball em backups/
./upgrade.sh 1.1.0        # atualiza (faz backup, verifica saúde, reverte se falhar)
./restore.sh backups/AAAAMMDD-HHMMSS.mailiq-backup.tar.gz
```

O `.env` guarda a chave que decifra as credenciais SSH dos servidores
monitorados. Ele nunca sai desta máquina — mantenha uma cópia offline
(o `backup.sh` a empacota junto). Ver [docs/atualizar.md](docs/atualizar.md).

## Versão em execução

`https://SEU-DOMINIO/api/version` — ou o rodapé do painel. O número bate
com a tag das imagens e com o `CHANGELOG.md` do release.
