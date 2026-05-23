"""
Rate limiting centralizado via slowapi.

Importar `limiter` nos routers e aplicar como decorator:

    from ..limiter import limiter

    @router.post("/login")
    @limiter.limit("5/minute")
    def login(request: Request, ...):
        ...

O `request: Request` é obrigatório para o slowapi extrair o IP do cliente.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[],          # sem limite global — aplicado por rota
    headers_enabled=True,       # devolve X-RateLimit-* nos headers
)
