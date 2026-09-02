# Testes

Testes de aceite, um por arquivo `test_*.sh`. Quase todo teste nasceu de
um defeito real e cita, no cabeçalho, o dado que o causou.

## O que roda no CI

| Workflow | O que roda | Onde |
|---|---|---|
| **Tests** | `tests/run-ci.sh` (subconjunto autocontido) + `compileall` do backend + `import app.main` + `npm run build` do frontend + `bash -n` em todo `*.sh` | todo push/PR |
| **Migrations** | `tests/test_migrations.sh` — idempotência do runner de migrations, em Postgres descartável | todo push/PR |
| **Build & Push** | build das imagens backend/frontend (valida os Dockerfiles) | todo push/PR; publica só em tag/main |

`tests/run-ci.sh` roda:

- `test_detectors.sh` — os 4 detectores (`detectors.py` é puro, só stdlib).
- `test_log_recognition.sh` — `analyze_log()`/`classify()` do `diag-exim.sh`
  contra fixtures, sem Exim.
- `test_check_sanity.sh` — sanidade das checagens DNSBL/cert do script;
  tolera falta de rede (cai em `desconhecido`).
- `test_license.sh` — assinatura, estados e o único bloqueio da licença
  (`license.py` só usa `cryptography`; assina com uma chave de teste
  gerada na hora, então não depende da chave de produção).
- `test_watchdog.sh` — os três modos de falha silenciosa do coletor, com
  um coletor falso e o relógio empurrado à mão. Stub de `config`,
  `database`, `alerts` e `collector`: roda só com a stdlib, então uma
  falha aqui é sempre do watchdog, nunca do ambiente.

## O que NÃO roda no CI (e por quê)

**Precisam do stack de dev de pé** (`docker compose up`, credenciais em
`backend/.env`) — batem a API real, logados:

```
test_audit_trail_api      test_collection_freshness   test_credential_failure_api
test_dnsbl_hysteresis     test_health_single_source   test_incident_impact
test_incident_notify      test_incident_report        test_incidents_api
test_monthly_report       test_no_test_residue        test_reputation_api
test_server_privilege_api test_server_scope           test_alert_channels
```

**Precisam de Exim / iptables / SSH reais** — removem mensagem de fila,
bloqueiam IP, sobem o `mailiq-bootstrap.sh`:

```
test_action_verification  test_bootstrap_e2e   test_capability_probe
test_ip_block             test_menu_dedup      test_observation_mode
test_plan_apply_api       test_quarantine      test_ssh_conn_pool
```

Rodar a suíte completa exige uma máquina com o stack de dev + Exim +
iptables (é o ambiente do servidor de testes do projeto). Cobrir esses
no CI — um container com Exim configurado entregando mensagem — é
trabalho pós-M1.

## Rodar localmente

```bash
# subconjunto do CI, rápido, sem dependências
bash tests/run-ci.sh

# idempotência das migrations (precisa de Docker)
bash tests/test_migrations.sh

# um teste de API (precisa do stack de dev de pé)
docker compose up -d
bash tests/test_incidents_api.sh
```

