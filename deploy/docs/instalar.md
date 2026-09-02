# Instalar o Mail IQ

## Pré-requisitos

- Um servidor Linux só para o painel (não precisa ser um servidor de
  e-mail). 1 vCPU / 2 GB de RAM já rodam. Docker + plugin Compose.
- Um subdomínio (ex.: `monitor.suaempresa.com.br`) com registro **A**
  apontando para o IP deste servidor **antes** de instalar — o Caddy
  emite o certificado TLS na primeira requisição.
- Portas **80** e **443** livres e abertas no firewall do provedor.
- Credencial de leitura do registry de imagens (ver abaixo).

## Acesso às imagens (ghcr.io)

As imagens do painel são privadas. Você recebe, junto com a licença, um
**Personal Access Token** do GitHub com escopo `read:packages` (somente
leitura). O `install.sh` pede usuário e token e roda `docker login` por
você; se preferir, antes de rodar:

```bash
docker login ghcr.io -u SEU_USUARIO_GITHUB
# senha = o token read:packages
```

O login fica salvo em `~/.docker/config.json` — o `upgrade.sh` reaproveita.

## Instalação

```bash
cd deploy
cp .env.example .env
$EDITOR .env          # DOMAIN, POSTGRES_PASSWORD, ADMIN_PASSWORD, JWT_SECRET, SSH_ENCRYPTION_KEY
./install.sh
```

O `install.sh` também gera os segredos que você deixar em branco, escreve
o `.env` (chmod 600), puxa as imagens e sobe a stack. Ao terminar, o
painel está em `https://SEU-DOMINIO`.

Rodar de novo é seguro: ele detecta o `.env` existente e **reaproveita**
`POSTGRES_PASSWORD`, `SSH_ENCRYPTION_KEY` e `JWT_SECRET` (trocá-los
quebraria o banco já inicializado e as credenciais SSH já cifradas).

## Conectar o primeiro servidor Exim

1. No painel: **Servidores → Adicionar → Gerar chave**. Copie a chave
   pública mostrada.
2. **No servidor Exim** (não nesta máquina), como root, uma vez — leia o
   script inteiro antes:
   ```bash
   bash mailiq-bootstrap.sh --pubkey 'ssh-ed25519 AAAA... mailiq@painel'
   ```
   Cria o usuário `mailiq` (sem senha, só chave), instala a chave e
   escreve o sudoers mínimo.
3. Volte ao painel e clique **Testar conexão**.

O `mailiq-bootstrap.sh` e o sudoers de referência estão no pacote
`diag-exim` (público, MIT) e na documentação de segurança do produto.

## Depois

| | |
|---|---|
| Atualizar | `./upgrade.sh <versão>` — ver [atualizar.md](atualizar.md) |
| Backup | `./backup.sh` (rode antes de qualquer mudança grande; o `upgrade.sh` já roda) |
| Logs | `docker compose logs -f backend` |
| Parar / subir | `docker compose down` / `docker compose up -d` |
