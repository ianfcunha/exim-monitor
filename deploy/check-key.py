"""
Valida se uma SSH_ENCRYPTION_KEY (Fernet) decifra os segredos SSH
contidos num dump SQL do Mail IQ — usado pelo restore.sh ANTES de
sobrescrever qualquer coisa.

Uso:  FERNET_KEY=<chave>  python check-key.py <dump.sql>

Saída:
  0  ao menos um segredo do dump decifra com esta chave  → pode restaurar
  2  o dump não tem segredos cifrados (nenhum servidor)   → nada a validar
  3  há segredos, mas NENHUM decifra com esta chave       → NÃO restaure
  4  a chave em si é malformada
"""
import os
import re
import sys

from cryptography.fernet import Fernet, InvalidToken

if len(sys.argv) != 2:
    print("uso: FERNET_KEY=<chave> python check-key.py <dump.sql>", file=sys.stderr)
    sys.exit(4)

raw_key = os.environ.get("FERNET_KEY", "").strip()
if not raw_key:
    print("FERNET_KEY não definida", file=sys.stderr)
    sys.exit(4)

try:
    fernet = Fernet(raw_key.encode())
except Exception as exc:  # noqa: BLE001
    print(f"chave Fernet malformada: {exc}", file=sys.stderr)
    sys.exit(4)

try:
    with open(sys.argv[1], "r", errors="replace") as fh:
        text = fh.read()
except OSError as exc:
    print(f"não consegui ler o dump: {exc}", file=sys.stderr)
    sys.exit(4)

# Token Fernet: base64url começando com 'gAAAAA' (versão 0x80 + timestamp).
# No dump plain do pg_dump cada valor fica numa linha só (formato COPY),
# então o token nunca é quebrado.
tokens = set(re.findall(r"gAAAAA[A-Za-z0-9_\-=]{20,}", text))

if not tokens:
    print("nenhum segredo SSH cifrado encontrado no dump", file=sys.stderr)
    sys.exit(2)

for token in tokens:
    try:
        fernet.decrypt(token.encode())
    except (InvalidToken, ValueError):
        continue
    print(f"ok: {len(tokens)} token(s) no dump, ao menos 1 decifra com esta chave")
    sys.exit(0)

print(f"{len(tokens)} token(s) no dump — NENHUM decifra com esta chave", file=sys.stderr)
sys.exit(3)
