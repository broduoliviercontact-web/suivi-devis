-- Mise à jour n°2 (29/10/2026) : fiches événement + numéros de besoin attribués par la base.
-- À coller une seule fois dans Supabase > SQL Editor > New query, puis "Run". Peut être relancée sans risque.

-- 1. Les fiches événement (nom, dates, lieu, notes, style de l'étiquette).
create table if not exists public.evenements (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.evenements enable row level security;

-- 2. La fusion de champs fonctionne aussi pour les événements.
create or replace function public.merge_doc(t text, doc_id text, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if t = 'devis' then
    update public.devis set data = data || patch, updated_at = now() where id = doc_id;
  elsif t = 'offres' then
    update public.offres set data = data || patch, updated_at = now() where id = doc_id;
  elsif t = 'evenements' then
    update public.evenements set data = data || patch, updated_at = now() where id = doc_id;
  else
    raise exception 'table inconnue %', t;
  end if;
end $$;
revoke all on function public.merge_doc(text, text, jsonb) from public, anon, authenticated;

-- 3. Numéros de besoin (#001, #002…) donnés par la base : jamais deux fois le même,
--    même si deux personnes créent un besoin à la même seconde.
create sequence if not exists public.devis_num_seq;
select setval('public.devis_num_seq',
  coalesce((select max((data->>'num')::int) from public.devis where data->>'num' ~ '^[0-9]+$'), 0) + 1, false);

create or replace function public.create_devis(doc_id text, doc jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  n := nextval('public.devis_num_seq');
  insert into public.devis (id, data) values (doc_id, doc || jsonb_build_object('num', n));
  return n;
end $$;
revoke all on function public.create_devis(text, jsonb) from public, anon, authenticated;
