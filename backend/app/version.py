"""
Versão da aplicação — fonte única.

`APP_VERSION` é a versão semântica publicada: bate com a tag git
`vX.Y.Z` e com a tag das imagens Docker (`backend:X.Y.Z`). Ao cortar
um release, subir aqui, registrar em `CHANGELOG.md` e dar push da tag.

`BUILD_SHA` é injetado no build da imagem (ARG/ENV `MAILIQ_BUILD_SHA`
no Dockerfile, preenchido pelo CI). Em execução a partir do código-fonte
(dev, `docker compose up` sem CI) fica como `"dev"`.
"""
import os
from datetime import datetime, timezone

APP_VERSION = "1.0.0"

BUILD_SHA = os.getenv("MAILIQ_BUILD_SHA", "").strip() or "dev"

STARTED_AT = datetime.now(timezone.utc)


def version_info() -> dict:
    """Bloco de versão consumido por GET /api/version e pelo rodapé do painel."""
    return {
        "version": APP_VERSION,
        "build_sha": BUILD_SHA,
        "started_at": STARTED_AT.isoformat(),
    }
