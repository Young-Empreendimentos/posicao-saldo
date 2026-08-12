# Posição de Saldo — Young Empreendimentos

Dashboard de **posição de caixa**: saldo das contas correntes por **banco** e por **empresa**, a partir do **Sienge**, excluindo **XP, Alelo e contas mútuo**.

## Arquitetura

```
Sienge API ─► Edge Function (posicao-caixa-sync) ─► Supabase (schema posicao_caixa) ─► Dashboard
  /checking-accounts + /accounts-balances            contas · saldos · vw_posicao        (login Google + RLS)
```

- **Fonte:** API REST do Sienge — `GET /accounts-balances` (o relatório "Posição de Saldos") + `GET /checking-accounts` (banco/nome/empresa).
- **Banco:** schema `posicao_caixa` no Supabase (`young-workspace`). Tabelas `contas`, `saldos`, view `vw_posicao` (já exclui `considerar=false`).
- **Acesso:** login Google (@youngempreendimentos.com.br) + allowlist `posicao_caixa.usuarios` + RLS (padrão dos outros sistemas Young).
- **Atualização:** a cada 15 dias (cron) + botão "Atualizar" no dashboard.

## Arquivos

| Caminho | O que é |
|---|---|
| `dashboard.html` | Dashboard (HTML auto-contido). Hoje com **dados de exemplo**. |
| `supabase/functions/posicao-caixa-sync/index.ts` | Edge Function que puxa o Sienge e grava no banco. |
| `db/schema.sql` | DDL do schema `posicao_caixa` (tabelas, view, RLS, funções, RPC). |
| `posicao_saldo.py` | Alternativa em Python (gera CSV). Requer Python instalado. |

## Segredos (NUNCA commitar)

A Edge Function lê estes *secrets* do Supabase (Edge Functions → Secrets):

- `SIENGE_API_USER` — usuário da API (`youngemp-elen`)
- `SIENGE_API_PASSWORD` — senha da API do Sienge
- `SIENGE_SUBDOMAIN` — opcional (padrão `youngemp`)

> ⚠️ **Segurança:** os dados reais de caixa são **privados**. Nunca publique um HTML com saldo real num host público (GitHub Pages é público). O dashboard "de produção" deve ler do Supabase **após login** (RLS protege), sem dado embutido no arquivo.
