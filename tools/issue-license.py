#!/usr/bin/env python3
"""
Emissão de licenças do Mail IQ (uso interno — não vai para o cliente).

A chave PRIVADA de assinatura NÃO mora neste repositório. Ela fica num
arquivo fora da árvore do projeto (default ~/.mailiq/license-signing-key.pem)
e é o único segredo que permite emitir licenças. Perdê-la significa gerar um
par novo e reemitir tudo; vazá-la significa que qualquer um emite licença.
Faça backup dela em cofre, não em repositório.

Uso
───
  # uma única vez, ao montar a operação:
  ./tools/issue-license.py new-key
      → grava a chave privada e imprime a pública para colar em
        backend/app/license.py (_PUBLIC_KEY_B64)

  # a cada cliente / renovação:
  ./tools/issue-license.py issue --customer "i7host" --servers 5 --months 12
      → imprime o token para o cliente pôr em MAILIQ_LICENSE

  # conferir um token qualquer (usa só a chave pública do backend):
  ./tools/issue-license.py verify <token>

Requer a lib `cryptography` (já é dependência do backend).
"""
import argparse
import json
import os
import stat
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: E402

from app.license import b64url_encode, canonical_payload, verify_token  # noqa: E402

DEFAULT_KEY_PATH = Path(
    os.getenv("MAILIQ_LICENSE_KEY", Path.home() / ".mailiq" / "license-signing-key.pem")
)


def cmd_new_key(args: argparse.Namespace) -> int:
    path = Path(args.out)
    if path.exists() and not args.force:
        print(f"ERRO: {path} já existe. Use --force para sobrescrever "
              f"(isso INVALIDA todas as licenças já emitidas).", file=sys.stderr)
        return 1

    private_key = ed25519.Ed25519PrivateKey.generate()
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pem)
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600

    raw_pub = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    import base64
    pub_b64 = base64.b64encode(raw_pub).decode("ascii")

    print(f"Chave privada gravada em {path} (modo 0600).")
    print("Faça backup dela em cofre. Ela NÃO pode ir para o repositório.\n")
    print("Cole a linha abaixo em backend/app/license.py:\n")
    print(f'_PUBLIC_KEY_B64 = "{pub_b64}"')
    return 0


def _load_private_key(path: Path) -> ed25519.Ed25519PrivateKey:
    if not path.exists():
        raise SystemExit(
            f"ERRO: chave privada não encontrada em {path}.\n"
            "Gere com: ./tools/issue-license.py new-key\n"
            "ou aponte para a existente com MAILIQ_LICENSE_KEY=/caminho/da/chave.pem"
        )
    mode = path.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"AVISO: {path} está legível por outros usuários. "
              f"Corrija com: chmod 600 {path}", file=sys.stderr)
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise SystemExit(f"ERRO: {path} não é uma chave Ed25519.")
    return key


def cmd_issue(args: argparse.Namespace) -> int:
    private_key = _load_private_key(Path(args.key))

    now = datetime.now(timezone.utc).replace(microsecond=0)
    if args.until:
        expires = datetime.fromisoformat(args.until)
        if not expires.tzinfo:
            expires = expires.replace(tzinfo=timezone.utc)
    else:
        # 30 dias por mês — prazo comercial, não calendário contábil.
        expires = now + timedelta(days=30 * args.months)

    if expires <= now:
        raise SystemExit("ERRO: a data de vencimento já passou.")

    payload = {
        "customer":    args.customer,
        "license_id":  args.license_id or f"lic_{uuid.uuid4().hex[:12]}",
        "issued_at":   now.isoformat(),
        "expires_at":  expires.isoformat(),
        "max_servers": args.servers,
        "features":    sorted(set(args.feature or [])),
    }

    payload_b64 = canonical_payload(payload)
    sig_b64 = b64url_encode(private_key.sign(payload_b64.encode("ascii")))
    token = f"{payload_b64}.{sig_b64}"

    if args.json:
        print(json.dumps({"payload": payload, "token": token}, indent=2, ensure_ascii=False))
        return 0

    print("─" * 72)
    print(f"  Cliente:     {payload['customer']}")
    print(f"  Licença:     {payload['license_id']}")
    print(f"  Servidores:  {payload['max_servers']}")
    print(f"  Emitida:     {payload['issued_at']}")
    print(f"  Vence:       {payload['expires_at']}")
    if payload["features"]:
        print(f"  Recursos:    {', '.join(payload['features'])}")
    print("─" * 72)
    print("\nEntregue ao cliente — no .env do painel:\n")
    print(f"MAILIQ_LICENSE={token}\n")
    print("Depois de salvar o .env: docker compose up -d backend")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    # Verifica com a MESMA chave pública embutida no backend — é o teste real
    # de que o token que estamos entregando vai ser aceito lá.
    status = verify_token(args.token)
    print(f"estado:      {status.state}")
    print(f"válida:      {status.valid}")
    print(f"detalhe:     {status.detail}")
    if status.customer:
        print(f"cliente:     {status.customer}")
        print(f"licença:     {status.license_id}")
        print(f"vence:       {status.expires_at}")
        print(f"dias:        {status.days_left}")
        print(f"servidores:  {status.max_servers}")
        print(f"recursos:    {status.features or '—'}")
    return 0 if status.valid else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emite e confere licenças do Mail IQ.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_new = sub.add_parser("new-key", help="gera o par de assinatura (uma vez só)")
    p_new.add_argument("--out", default=str(DEFAULT_KEY_PATH),
                       help=f"caminho da chave privada (default: {DEFAULT_KEY_PATH})")
    p_new.add_argument("--force", action="store_true",
                       help="sobrescreve uma chave existente (invalida tudo já emitido)")
    p_new.set_defaults(func=cmd_new_key)

    p_iss = sub.add_parser("issue", help="emite uma licença")
    p_iss.add_argument("--customer", required=True, help="nome do cliente")
    p_iss.add_argument("--servers", type=int, required=True, help="máximo de servidores")
    p_iss.add_argument("--months", type=int, default=12, help="validade em meses (default: 12)")
    p_iss.add_argument("--until", help="vencimento explícito ISO-8601 (sobrepõe --months)")
    p_iss.add_argument("--license-id", help="id da licença (default: gerado)")
    p_iss.add_argument("--feature", action="append", help="recurso extra (repetível)")
    p_iss.add_argument("--key", default=str(DEFAULT_KEY_PATH), help="chave privada")
    p_iss.add_argument("--json", action="store_true", help="saída em JSON")
    p_iss.set_defaults(func=cmd_issue)

    p_ver = sub.add_parser("verify", help="confere um token contra a chave pública do backend")
    p_ver.add_argument("token")
    p_ver.set_defaults(func=cmd_verify)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
