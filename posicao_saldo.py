#!/usr/bin/env python3
"""
Posicao de Saldo - Young Empreendimentos
========================================
Puxa o saldo das contas correntes do Sienge (relatorio "Posicao de Saldos"),
junta com o cadastro de contas (banco / nome / empresa), exclui XP / Alelo /
mutuos, agrupa por empresa+banco e gera CSVs prontos para o Looker Studio.

APIs Sienge usadas:
  GET /accounts-balances   -> saldo por conta (amount) numa data
  GET /checking-accounts   -> cadastro: bankName, accountName, companyName, tipo

Uso (PowerShell no Windows):
  $env:SIENGE_API_PASSWORD = "SUA_SENHA_DA_API"   # NAO comitar / NAO colar em chat
  python posicao_saldo.py                 # saldo de hoje
  python posicao_saldo.py 2026-07-31      # saldo numa data especifica (ex.: fim do mes)

Requer: pip install requests
"""

import os
import sys
import csv
import datetime
import unicodedata

import requests  # pip install requests

# ----------------------------------------------------------------------------
# Configuracao
# ----------------------------------------------------------------------------
SUBDOMAIN = "youngemp"
BASE = f"https://api.sienge.com.br/{SUBDOMAIN}/public/api/v1"

USER = os.environ.get("SIENGE_API_USER", "youngemp-elen")
PASSWORD = os.environ.get("SIENGE_API_PASSWORD")  # obrigatorio via variavel de ambiente

# Contas a considerar no saldo: "ENABLED" (ativas), "DISABLED" ou "ALL"
ACCOUNT_STATUS = "ENABLED"

# False = usa `amount` (saldo contabil, igual ao relatorio Posicao de Saldos)
# True  = usa `reconciledAmount` (saldo conciliado)
USE_RECONCILED = False

# Exclusoes pedidas pelo Eduardo/Suelen (comparacao sem acento, maiuscula, "contem"):
EXCLUDE_BANK_KEYWORDS = ["XP", "ALELO"]   # casa em bankName  (XP pega as 2 contas de uma vez)
EXCLUDE_NAME_KEYWORDS = ["MUTUO"]          # casa em accountName / tipo da conta ("mutuo")


# ----------------------------------------------------------------------------
def norm(s):
    """Normaliza para comparacao: sem acento, maiuscula, sem espacos nas pontas."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return s.upper().strip()


def make_session():
    if not PASSWORD:
        sys.exit("ERRO: defina a senha da API em SIENGE_API_PASSWORD "
                 "(ex.: $env:SIENGE_API_PASSWORD = \"...\"  no PowerShell).")
    s = requests.Session()
    s.auth = (USER, PASSWORD)  # Basic Auth
    s.headers.update({"Accept": "application/json"})
    return s


def get_all(session, path, params, page_size):
    """Percorre todas as paginas (limit/offset) e devolve a lista completa de results."""
    out = []
    offset = 0
    while True:
        page = dict(params, limit=page_size, offset=offset)
        r = session.get(f"{BASE}{path}", params=page, timeout=60)
        if r.status_code == 401:
            sys.exit("ERRO 401: usuario/senha da API invalidos "
                     f"(usuario atual: {USER}).")
        r.raise_for_status()
        data = r.json()
        results = data.get("results") or []
        out.extend(results)
        meta = data.get("resultSetMetadata") or {}
        count = meta.get("count", len(out))
        offset += page_size
        if not results or offset >= count:
            break
    return out


def main():
    balance_date = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat()
    session = make_session()

    # 1) Cadastro de contas correntes (banco / nome / empresa / tipo)
    accounts = get_all(session, "/checking-accounts", {"accountStatus": "ALL"}, 200)
    registry = {}
    for a in accounts:
        key = (norm(a.get("accountNumber")), a.get("companyId"))
        registry[key] = a

    # 2) Saldos na data informada (carrega ultimo saldo se nao houver na data)
    balances = get_all(
        session,
        "/accounts-balances",
        {
            "balanceDate": balance_date,
            "accountStatus": ACCOUNT_STATUS,
            "showLastBalanceIfNotExistBalance": "S",
        },
        300,
    )

    # 3) Junta cadastro + saldo  e  4) aplica exclusoes
    rows = []
    excluidas = []
    for b in balances:
        key = (norm(b.get("accountNumber")), b.get("companyId"))
        a = registry.get(key, {})

        bank = a.get("bankName") or ""
        acct_name = a.get("accountName") or ""
        acct_type = (a.get("accountType") or {}).get("description") or ""
        company = a.get("companyName") or f"(empresa {b.get('companyId')})"
        amount = b.get("reconciledAmount" if USE_RECONCILED else "amount") or 0.0

        nb, nn, nt = norm(bank), norm(acct_name), norm(acct_type)
        drop = (any(k in nb for k in EXCLUDE_BANK_KEYWORDS)
                or any(k in nn or k in nt for k in EXCLUDE_NAME_KEYWORDS))

        record = {
            "empresa": company,
            "banco": bank,
            "conta": acct_name or b.get("accountNumber"),
            "accountNumber": b.get("accountNumber"),
            "tipo_conta": acct_type,
            "saldo": round(float(amount), 2),
            "data_saldo": b.get("balanceDate") or balance_date,
        }
        (excluidas if drop else rows).append(record)

    # 5) CSV detalhado (uma linha por conta)
    campos = ["empresa", "banco", "conta", "accountNumber", "tipo_conta", "saldo", "data_saldo"]
    with open("posicao_saldo_detalhado.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=campos)
        w.writeheader()
        w.writerows(rows)

    # 6) CSV agrupado por empresa + banco
    agg = {}
    for r in rows:
        k = (r["empresa"], r["banco"])
        agg[k] = agg.get(k, 0.0) + r["saldo"]
    resumo = [{"empresa": e, "banco": bk, "saldo": round(v, 2)}
              for (e, bk), v in sorted(agg.items())]
    with open("posicao_saldo_por_banco.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["empresa", "banco", "saldo"])
        w.writeheader()
        w.writerows(resumo)

    # Resumo no console (sanidade)
    total = sum(r["saldo"] for r in rows)
    print(f"Data do saldo : {balance_date}")
    print(f"Contas usadas : {len(rows)}   |   excluidas (XP/Alelo/mutuo): {len(excluidas)}")
    print(f"Saldo TOTAL   : R$ {total:,.2f}")
    print("-" * 72)
    for r in resumo:
        print(f"  {r['empresa'][:30]:30}  {r['banco'][:20]:20}  R$ {r['saldo']:>16,.2f}")
    print("-" * 72)
    print("Gerados: posicao_saldo_detalhado.csv  e  posicao_saldo_por_banco.csv")
    if excluidas:
        print("\nExcluidas (confira se estao corretas):")
        for r in excluidas:
            print(f"  - {r['banco']} / {r['conta']} ({r['empresa']})  R$ {r['saldo']:,.2f}")


if __name__ == "__main__":
    main()
