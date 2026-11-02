-- ============================================================================
--  StockFlow  •  Supabase Row Level Security
--  Run AFTER supabase/schema.sql.
--
--  ── How this app handles auth ──────────────────────────────────────────────
--  The browser never talks to Supabase directly. It calls the Node API at
--  `/api/*` with a JWT issued by the API itself, and every permission check is
--  enforced server-side in src/lib/perm.js. The API talks to Postgres over the
--  direct connection string as the table owner (`postgres`, which has BYPASSRLS
--  and also owns the tables).
--
--  Therefore the correct posture is **deny-all for the public Supabase roles**:
--  even if someone extracts the anon key — which is designed to be public — they
--  cannot read a single row. Only the server's database connection can.
--
--  This is defence in depth, not the primary control. The primary controls are
--  password hashing (bcrypt), server-side permission checks and database
--  transactions. See SECURITY note at the bottom.
-- ============================================================================

-- 1. Turn on RLS everywhere.
alter table roles            enable row level security;
alter table permissions      enable row level security;
alter table role_permissions enable row level security;
alter table users            enable row level security;
alter table categories       enable row level security;
alter table products         enable row level security;
alter table inventory        enable row level security;
alter table stock_movements  enable row level security;
alter table invoices         enable row level security;
alter table invoice_items    enable row level security;
alter table counters         enable row level security;
alter table activity_log     enable row level security;

-- 2. Remove every grant from the public API roles. RLS with no policy already
--    returns zero rows, but revoking the grants fails fast and loudly instead
--    of silently returning empty arrays.
do $$
declare
  t text;
  public_roles text[] := array['anon', 'authenticated'];
  r text;
begin
  foreach t in array array[
    'roles','permissions','role_permissions','users','categories','products',
    'inventory','stock_movements','invoices','invoice_items','counters','activity_log'
  ] loop
    foreach r in array public_roles loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;

  -- Sequences too: no sneaking ids in via nextval().
  foreach r in array public_roles loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all sequences in schema public from %I', r);
    end if;
  end loop;
end $$;

-- 3. Explicit deny policies. `using (false)` documents the intent and makes the
--    posture visible in the Supabase dashboard's policy list.
do $$
declare
  t text;
begin
  foreach t in array array[
    'roles','permissions','role_permissions','users','categories','products',
    'inventory','stock_movements','invoices','invoice_items','counters','activity_log'
  ] loop
    execute format('drop policy if exists deny_public_access on public.%I', t);
    execute format(
      'create policy deny_public_access on public.%I as permissive for all to public using (false) with check (false)', t
    );
  end loop;
end $$;

-- ============================================================================
--  NOTE — do not add `force row level security`.
--  The API connects as `postgres`, the table owner. `enable` RLS exempts the
--  owner; `force` would subject that connection to these deny-all policies and
--  take the whole application offline. Keep it as-is.
-- ============================================================================

-- ============================================================================
--  OPTIONAL — direct Supabase-Auth access from a browser client
--
--  If you later add a Supabase JS client to the frontend instead of the Node
--  API, you must (a) link app users to Supabase Auth identities and (b) replace
--  the deny-all policies with permission-aware ones. The schema deliberately
--  does *not* ship an auth link, because unused columns invite confusion.
--
--    -- 1. link a user row to an auth.users identity
--    alter table users add column if not exists auth_id uuid unique
--      references auth.users(id) on delete cascade;
--
--    -- 2. helpers (security definer so they can read past RLS themselves)
--    create or replace function app_user_id()
--    returns integer language sql stable security definer set search_path = public as $$
--      select id from users where auth_id = auth.uid() and status = 'active'
--    $$;
--
--    create or replace function app_role()
--    returns text language sql stable security definer set search_path = public as $$
--      select r.name from users u join roles r on r.id = u.role_id
--       where u.auth_id = auth.uid() and u.status = 'active'
--    $$;
--
--    create or replace function app_can(p_code text)
--    returns boolean language sql stable security definer set search_path = public as $$
--      select exists (
--        select 1 from users u
--          join role_permissions rp on rp.role_id = u.role_id
--          join permissions p on p.id = rp.permission_id
--         where u.auth_id = auth.uid() and u.status = 'active' and p.code = p_code
--      )
--    $$;
--
--    -- 3. drop the deny-all policies, then grant by permission, e.g.
--    drop policy if exists deny_public_access on public.products;
--    create policy products_read on public.products for select
--      to authenticated using (app_can('products.view'));
--
--    create policy products_write on public.products for all
--      to authenticated using (app_can('products.update'))
--      with check (app_can('products.update'));
--
--    create policy invoices_own on public.invoices for select
--      to authenticated using (created_by = app_user_id() or app_can('invoices.view'));
--
--  Never expose the service_role key to the browser: it bypasses RLS entirely.
--  Only the publishable/anon key is safe in client code, and only with policies
--  like the ones above.
-- ============================================================================

-- 4. Verification — after running this, every row should show rowsecurity = true
--    and policies >= 1.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and c.relname in ('roles','permissions','role_permissions','users','categories',
                     'products','inventory','stock_movements','invoices','invoice_items',
                     'counters','activity_log')
 order by c.relname;
