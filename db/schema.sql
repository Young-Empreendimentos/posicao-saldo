-- =============================================================================
-- Posição de Saldo — schema posicao_caixa (Supabase young-workspace)
-- Consolidado das migrações aplicadas em 2026-08-12.
-- =============================================================================

create schema if not exists posicao_caixa;

-- Cadastro de contas (espelho de /checking-accounts)
create table if not exists posicao_caixa.contas (
  company_id      integer      not null,
  account_number  text         not null,
  account_name    text,
  agency_number   text,
  account_type    text,
  bank_number     text,
  bank_name       text,
  company_name    text,
  account_status  text,
  considerar      boolean      not null default true,   -- false = XP, Alelo, mútuo
  empreendimento  text,                                  -- mapeado depois (empresa->empreendimento)
  updated_at      timestamptz  not null default now(),
  primary key (company_id, account_number)
);

-- Saldos por data (espelho de /accounts-balances)
create table if not exists posicao_caixa.saldos (
  balance_date      date          not null,
  company_id        integer       not null,
  account_number    text          not null,
  amount            numeric(15,2) not null default 0,
  reconciled_amount numeric(15,2),
  account_status    text,
  captured_at       timestamptz   not null default now(),
  primary key (balance_date, company_id, account_number)
);

-- View consolidada (respeita RLS de quem consulta; já exclui considerar=false)
create or replace view posicao_caixa.vw_posicao as
select s.balance_date, s.company_id, c.company_name,
       s.account_number, c.account_name, c.account_type,
       c.bank_number, c.bank_name, c.empreendimento,
       s.amount, s.reconciled_amount
from posicao_caixa.saldos s
join posicao_caixa.contas c
  on c.company_id = s.company_id and c.account_number = s.account_number
where coalesce(c.considerar, true);
alter view posicao_caixa.vw_posicao set (security_invoker = true);

-- ---- Acesso: allowlist + RLS (padrão Young) ---------------------------------
do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                 where t.typname='app_role' and n.nspname='posicao_caixa') then
    create type posicao_caixa.app_role as enum ('admin','viewer');
  end if;
end $$;

create table if not exists posicao_caixa.usuarios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  email      text not null unique,
  nome       text,
  role       posicao_caixa.app_role not null default 'viewer',
  ativo      boolean not null default true,
  aprovado   boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid
);

create or replace function posicao_caixa.tg_lower_email() returns trigger
language plpgsql set search_path = '' as $$ begin new.email := lower(new.email); return new; end $$;
drop trigger if exists trg_lower_email on posicao_caixa.usuarios;
create trigger trg_lower_email before insert or update of email on posicao_caixa.usuarios
for each row execute function posicao_caixa.tg_lower_email();

create or replace function public.posicao_caixa_is_member()
returns boolean language sql stable security definer
set search_path to 'posicao_caixa','public' as $$
  select exists (select 1 from posicao_caixa.usuarios
    where lower(email)=lower(auth.jwt()->>'email') and ativo and aprovado);
$$;
create or replace function public.posicao_caixa_is_admin()
returns boolean language sql stable security definer
set search_path to 'posicao_caixa','public' as $$
  select exists (select 1 from posicao_caixa.usuarios
    where lower(email)=lower(auth.jwt()->>'email') and ativo and aprovado and role='admin');
$$;
revoke execute on function public.posicao_caixa_is_member() from public;
revoke execute on function public.posicao_caixa_is_admin()  from public;
grant  execute on function public.posicao_caixa_is_member() to authenticated;
grant  execute on function public.posicao_caixa_is_admin()  to authenticated;

alter table posicao_caixa.contas   enable row level security;
alter table posicao_caixa.saldos   enable row level security;
alter table posicao_caixa.usuarios enable row level security;

create policy pc_contas_sel_member on posicao_caixa.contas for select to authenticated using (public.posicao_caixa_is_member());
create policy pc_saldos_sel_member on posicao_caixa.saldos for select to authenticated using (public.posicao_caixa_is_member());
create policy pc_contas_sel_bi on posicao_caixa.contas for select to looker_reader using (true);
create policy pc_saldos_sel_bi on posicao_caixa.saldos for select to looker_reader using (true);
create policy pc_contas_admin_all on posicao_caixa.contas for all to authenticated
  using (public.posicao_caixa_is_admin()) with check (public.posicao_caixa_is_admin());
create policy pc_users_self_sel on posicao_caixa.usuarios for select to authenticated
  using (lower(email)=lower(auth.jwt()->>'email') or public.posicao_caixa_is_admin());
create policy pc_users_admin_all on posicao_caixa.usuarios for all to authenticated
  using (public.posicao_caixa_is_admin()) with check (public.posicao_caixa_is_admin());

grant usage on schema posicao_caixa to authenticated, looker_reader;
grant select on posicao_caixa.contas, posicao_caixa.saldos, posicao_caixa.usuarios, posicao_caixa.vw_posicao to authenticated;
grant select on posicao_caixa.contas, posicao_caixa.saldos, posicao_caixa.vw_posicao to looker_reader;
grant update on posicao_caixa.contas to authenticated;
grant insert, update, delete on posicao_caixa.usuarios to authenticated;

-- ---- Upsert usado pela Edge Function (service_role) --------------------------
create or replace function public.posicao_caixa_sync_upsert(p_contas jsonb, p_saldos jsonb)
returns json language plpgsql security definer
set search_path = 'posicao_caixa','public' as $$
declare v_c int := 0; v_s int := 0;
begin
  insert into posicao_caixa.contas
    (company_id, account_number, account_name, agency_number, account_type,
     bank_number, bank_name, company_name, account_status, considerar, updated_at)
  select (x->>'company_id')::int, x->>'account_number', x->>'account_name', x->>'agency_number',
         x->>'account_type', x->>'bank_number', x->>'bank_name', x->>'company_name',
         x->>'account_status', coalesce((x->>'considerar')::boolean, true), now()
  from jsonb_array_elements(coalesce(p_contas,'[]'::jsonb)) x
  on conflict (company_id, account_number) do update set
     account_name=excluded.account_name, agency_number=excluded.agency_number,
     account_type=excluded.account_type, bank_number=excluded.bank_number,
     bank_name=excluded.bank_name, company_name=excluded.company_name,
     account_status=excluded.account_status, considerar=excluded.considerar, updated_at=now();
  get diagnostics v_c = row_count;

  insert into posicao_caixa.saldos
    (balance_date, company_id, account_number, amount, reconciled_amount, account_status, captured_at)
  select (x->>'balance_date')::date, (x->>'company_id')::int, x->>'account_number',
         coalesce((x->>'amount')::numeric,0), (x->>'reconciled_amount')::numeric,
         x->>'account_status', now()
  from jsonb_array_elements(coalesce(p_saldos,'[]'::jsonb)) x
  on conflict (balance_date, company_id, account_number) do update set
     amount=excluded.amount, reconciled_amount=excluded.reconciled_amount,
     account_status=excluded.account_status, captured_at=now();
  get diagnostics v_s = row_count;

  return json_build_object('contas', v_c, 'saldos', v_s);
end $$;
revoke execute on function public.posicao_caixa_sync_upsert(jsonb,jsonb) from public;
grant  execute on function public.posicao_caixa_sync_upsert(jsonb,jsonb) to service_role;

-- Semente do primeiro admin (ajuste o e-mail conforme necessário):
-- insert into posicao_caixa.usuarios (email, nome, role, ativo, aprovado)
-- values ('elen@youngempreendimentos.com.br','Elen','admin',true,true)
-- on conflict (email) do update set role='admin', ativo=true, aprovado=true;
