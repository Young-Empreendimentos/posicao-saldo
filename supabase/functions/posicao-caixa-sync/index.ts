// Edge Function: posicao-caixa-sync
// Puxa saldos do Sienge (/checking-accounts + /accounts-balances), aplica a
// exclusão (XP / Alelo / mútuo) e faz upsert em posicao_caixa via RPC.
// Secrets necessários no Supabase: SIENGE_API_USER, SIENGE_API_PASSWORD (SIENGE_SUBDOMAIN opcional).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUBDOMAIN = Deno.env.get("SIENGE_SUBDOMAIN") ?? "youngemp";
const SIENGE_USER = Deno.env.get("SIENGE_API_USER") ?? "";
const SIENGE_PASS = Deno.env.get("SIENGE_API_PASSWORD") ?? "";
const BASE = `https://api.sienge.com.br/${SUBDOMAIN}/public/api/v1`;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const EXCLUDE_BANK = ["XP", "ALELO"];
const EXCLUDE_NAME = ["MUTUO"];
const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function siengeGet(path: string, params: Record<string, string>) {
  const auth = "Basic " + btoa(`${SIENGE_USER}:${SIENGE_PASS}`);
  const out: any[] = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const qs = new URLSearchParams({ ...params, limit: String(limit), offset: String(offset) });
    const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: auth, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Sienge ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const res = j.results ?? [];
    out.push(...res);
    const count = j.resultSetMetadata?.count ?? out.length;
    offset += limit;
    if (res.length === 0 || offset >= count) break;
  }
  return out;
}

async function isAllowed(req: Request): Promise<boolean> {
  const h = req.headers.get("Authorization") ?? "";
  const token = h.replace(/^Bearer\s+/i, "");
  if (token && token === SERVICE_KEY) return true; // agendador / admin
  try {
    const u = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: h } } });
    const { data, error } = await u.rpc("posicao_caixa_is_member");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!SIENGE_USER || !SIENGE_PASS)
      return json({ ok: false, error: "Faltam os secrets SIENGE_API_USER / SIENGE_API_PASSWORD no Supabase." }, 500);
    if (!(await isAllowed(req))) return json({ ok: false, error: "Nao autorizado." }, 403);

    const url = new URL(req.url);
    const balanceDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    const accounts = await siengeGet("/checking-accounts", { accountStatus: "ALL" });
    const balances = await siengeGet("/accounts-balances", {
      balanceDate,
      accountStatus: "ENABLED",
      showLastBalanceIfNotExistBalance: "S",
    });

    const p_contas = accounts.map((a: any) => {
      const nb = norm(a.bankName), nn = norm(a.accountName), nt = norm(a.accountType?.description);
      const considerar = !(EXCLUDE_BANK.some((k) => nb.includes(k)) || EXCLUDE_NAME.some((k) => nn.includes(k) || nt.includes(k)));
      return {
        company_id: a.companyId,
        account_number: String(a.accountNumber),
        account_name: a.accountName,
        agency_number: a.agencyNumber,
        account_type: a.accountType?.description,
        bank_number: a.bankNumber,
        bank_name: a.bankName,
        company_name: a.companyName,
        account_status: a.accountStatus,
        considerar,
      };
    });
    const p_saldos = balances.map((b: any) => ({
      balance_date: b.balanceDate ?? balanceDate,
      company_id: b.companyId,
      account_number: String(b.accountNumber),
      amount: b.amount ?? 0,
      reconciled_amount: b.reconciledAmount ?? null,
      account_status: b.accountStatus,
    }));

    const svc = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await svc.rpc("posicao_caixa_sync_upsert", { p_contas, p_saldos });
    if (error) throw error;

    return json({ ok: true, balanceDate, ...(data as object) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
