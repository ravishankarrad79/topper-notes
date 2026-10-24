create table if not exists public.documents (
  id uuid primary key,
  title text not null check (char_length(title) between 1 and 100),
  category text not null check (category in ('Polity', 'Class 10', 'Class 12', 'Master Computer', 'All Competition', 'Below Class 10', 'Other')),
  is_paid boolean not null default false,
  price numeric(10, 2) not null default 0,
  size text not null,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

alter table public.documents enable row level security;
grant all on table public.documents to service_role;
