// Edge Function: posicao-caixa-sync
// Puxa saldos do Sienge (/accounts-balances + /checking-accounts se liberada),
// aplica exclusão (XP/Alelo/mútuo) e faz upsert em posicao_caixa via RPC (que loga o run).
// Credencial: SIENGE_AUTH_HEADER (header "Basic ...") — a mesma da sync do espelho.
// Auth de quem chama: header x-cron-token (pg_cron) OU service key OU usuário na allowlist.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUBDOMAIN = Deno.env.get("SIENGE_SUBDOMAIN") ?? "youngemp";
const SIENGE_AUTH = (Deno.env.get("SIENGE_AUTH_HEADER") ?? Deno.env.get("SIENGE_AUTH") ?? "").trim();
const SIENGE_USER = Deno.env.get("SIENGE_API_USER") ?? "";
const SIENGE_PASS = Deno.env.get("SIENGE_API_PASSWORD") ?? "";
const BASE = `https://api.sienge.com.br/${SUBDOMAIN}/public/api/v1`;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const EXCLUDE_BANK = ["XP", "ALELO"];
const EXCLUDE_NAME = ["MUTUO"];
const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

function authHeader(): string {
  if (SIENGE_AUTH) return /^basic\s/i.test(SIENGE_AUTH) ? SIENGE_AUTH : ("Basic " + SIENGE_AUTH);
  return "Basic " + btoa(`${SIENGE_USER}:${SIENGE_PASS}`);
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function siengeGet(path: string, params: Record<string, string>) {
  const auth = authHeader();
  const out: any[] = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const qs = new URLSearchParams({ ...params, limit: String(limit), offset: String(offset) });
    const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: auth, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Sienge ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
  // 1) Agendador interno (pg_cron) via token no header
  const cronTok = req.headers.get("x-cron-token");
  if (cronTok) {
    try {
      const svc = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data } = await svc.rpc("posicao_caixa_valid_cron", { t: cronTok });
      if (data === true) return true;
    } catch { /* ignore */ }
  }
  // 2) Service role key direto
  const h = req.headers.get("Authorization") ?? "";
  const token = h.replace(/^Bearer\s+/i, "");
  if (token && token === SERVICE_KEY) return true;
  // 3) Usuário logado na allowlist
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
    if (!SIENGE_AUTH && (!SIENGE_USER || !SIENGE_PASS))
      return json({ ok: false, error: "Faltam credenciais do Sienge (SIENGE_AUTH_HEADER)." }, 500);
    if (!(await isAllowed(req))) return json({ ok: false, error: "Nao autorizado." }, 403);

    const url = new URL(req.url);
    const balanceDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    // Cadastro (nomes) — opcional: se /checking-accounts estiver 403, segue só com saldos.
    let accounts: any[] = [];
    let cadastro = false;
    try { accounts = await siengeGet("/checking-accounts", { accountStatus: "ALL" }); cadastro = true; }
    catch (e) { console.warn(`checking-accounts indisponivel: ${(e as Error).message}`); }
    const cad = new Map<string, any>();
    for (const a of accounts) cad.set(`${a.companyId}__${String(a.accountNumber)}`, a);

    const balances = await siengeGet("/accounts-balances", { balanceDate, accountStatus: "ALL", showLastBalanceIfNotExistBalance: "S" });

    const contasMap = new Map<string, any>();
    for (const b of balances) {
      const key = `${b.companyId}__${String(b.accountNumber)}`;
      if (contasMap.has(key)) continue;
      const a = cad.get(key);
      if (a) {
        const nb = norm(a.bankName), nn = norm(a.accountName), nt = norm(a.accountType?.description);
        contasMap.set(key, { company_id: a.companyId, account_number: String(a.accountNumber), account_name: a.accountName, agency_number: a.agencyNumber, account_type: a.accountType?.description, bank_number: a.bankNumber, bank_name: a.bankName, company_name: a.companyName, account_status: a.accountStatus, considerar: !(EXCLUDE_BANK.some((k) => nb.includes(k)) || EXCLUDE_NAME.some((k) => nn.includes(k) || nt.includes(k))) });
      } else {
        contasMap.set(key, { company_id: b.companyId, account_number: String(b.accountNumber), account_name: String(b.accountNumber), bank_name: null, company_name: `Empresa ${b.companyId}`, account_status: b.accountStatus, considerar: true });
      }
    }
    const p_contas = Array.from(contasMap.values());
    const p_saldos = balances.map((b: any) => ({ balance_date: b.balanceDate ?? balanceDate, company_id: b.companyId, account_number: String(b.accountNumber), amount: b.amount ?? 0, reconciled_amount: b.reconciledAmount ?? null, account_status: b.accountStatus }));

    const svc = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await svc.rpc("posicao_caixa_sync_upsert", { p_contas, p_saldos });
    if (error) throw error;

    return json({ ok: true, balanceDate, cadastro_nomes: cadastro, ...(data as object) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
