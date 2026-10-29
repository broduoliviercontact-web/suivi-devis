-- Suivi des devis : à coller une seule fois dans Supabase > SQL Editor > New query, puis "Run".

-- Les besoins (une ligne du tableau) et les propositions des fournisseurs.
create table if not exists public.devis (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.offres (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Personne ne lit ces tables directement depuis le navigateur :
-- seul le serveur du site (clé "service_role") y a accès.
alter table public.devis enable row level security;
alter table public.offres enable row level security;

-- Fusionne des champs dans un document existant (utilisé quand on coche une case, etc.).
create or replace function public.merge_doc(t text, doc_id text, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if t = 'devis' then
    update public.devis set data = data || patch, updated_at = now() where id = doc_id;
  elsif t = 'offres' then
    update public.offres set data = data || patch, updated_at = now() where id = doc_id;
  else
    raise exception 'table inconnue %', t;
  end if;
end $$;
revoke all on function public.merge_doc(text, text, jsonb) from public, anon, authenticated;

-- Le dossier privé qui garde les PDF des devis (20 Mo max par fichier).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('devis', 'devis', false, 20971520,
        array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- Puis exécuter aussi supabase/migration-2.sql (fiches événement + numéros attribués par la base).
