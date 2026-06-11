-- =============================================================================
-- GET! — Supabase schema bootstrap
-- =============================================================================
-- Run this once in the Supabase SQL Editor after creating the project.
--
-- Tables
--   user_words           per-user wordbook state (one row per lemma)
--   word_notes           free-form notes attached to a lemma (text + image url)
--   ai_examples          cached DeepSeek example sentences (per lemma + sense)
--   review_logs          one row per Ebbinghaus review attempt (Day 6)
--   punch_in_days        one row per day the user finished their queue
--
-- Storage
--   bucket `note-images` (private; RLS lets the owner read/write their own)
--
-- Auth model
--   We rely on Supabase Auth's `auth.users.id` (uuid) as the foreign key.
--   Row-Level Security is ON for every table; only the owner can read/write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. user_words
-- -----------------------------------------------------------------------------
create table if not exists public.user_words (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    lemma           text not null,
    status          text not null default 'new'
                      check (status in ('new', 'old')),
    -- Total successful lookups; also used by "按查询次数排序".
    query_count     integer not null default 1,
    -- Ebbinghaus level 0..7. 7 == graduated to "old friend".
    level           smallint not null default 0
                      check (level >= 0 and level <= 7),
    -- When the next review is due. Null = not scheduled (e.g. status='old').
    next_review_at  timestamptz,
    first_seen_at   timestamptz not null default now(),
    last_seen_at    timestamptz not null default now(),
    -- We treat (user_id, lemma) as the natural key.
    unique (user_id, lemma)
);

create index if not exists user_words_due_idx
    on public.user_words (user_id, next_review_at)
    where status = 'new' and next_review_at is not null;

-- -----------------------------------------------------------------------------
-- 2. word_notes
-- -----------------------------------------------------------------------------
create table if not exists public.word_notes (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    lemma           text not null,
    body            text not null default '',
    -- Storage path inside the `note-images` bucket. Null = text-only note.
    image_path      text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists word_notes_lemma_idx
    on public.word_notes (user_id, lemma, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. ai_examples — DeepSeek example-sentence cache (Day 4)
-- -----------------------------------------------------------------------------
create table if not exists public.ai_examples (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    lemma           text not null,
    -- Index of the sense the user picked when generating; null = primary.
    sense_index     smallint,
    en              text not null,
    cn              text,
    -- Lemmas highlighted in the sentence (subset of the user's wordbook at gen time).
    highlights      text[] not null default '{}',
    created_at      timestamptz not null default now()
);

create index if not exists ai_examples_lemma_idx
    on public.ai_examples (user_id, lemma, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. review_logs — Day 6
-- -----------------------------------------------------------------------------
create table if not exists public.review_logs (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    lemma           text not null,
    -- 'pass' = correct on first try; 'fail' = at least one wrong attempt.
    result          text not null check (result in ('pass', 'fail')),
    -- Ebbinghaus level the entry MOVED TO after this review.
    level_after     smallint not null,
    reviewed_at     timestamptz not null default now()
);

create index if not exists review_logs_user_day_idx
    on public.review_logs (user_id, reviewed_at desc);

-- -----------------------------------------------------------------------------
-- 5. punch_in_days — Day 7
-- -----------------------------------------------------------------------------
create table if not exists public.punch_in_days (
    user_id         uuid not null references auth.users(id) on delete cascade,
    -- Local-day key, format "YYYY-MM-DD" in the user's timezone (we resolve
    -- it on the client so different users in different TZs each see their
    -- own midnight).
    local_day       text not null,
    finished_count  integer not null default 0,
    primary key (user_id, local_day)
);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.user_words      enable row level security;
alter table public.word_notes      enable row level security;
alter table public.ai_examples     enable row level security;
alter table public.review_logs     enable row level security;
alter table public.punch_in_days   enable row level security;

-- The owner-only policy is the same everywhere; we'll just stamp it on each
-- table. `auth.uid()` returns the JWT's `sub`, i.e. the user id.

-- user_words
drop policy if exists "user_words owner read"   on public.user_words;
drop policy if exists "user_words owner write"  on public.user_words;
create policy "user_words owner read"  on public.user_words
    for select using (auth.uid() = user_id);
create policy "user_words owner write" on public.user_words
    for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- word_notes
drop policy if exists "word_notes owner read"   on public.word_notes;
drop policy if exists "word_notes owner write"  on public.word_notes;
create policy "word_notes owner read"  on public.word_notes
    for select using (auth.uid() = user_id);
create policy "word_notes owner write" on public.word_notes
    for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ai_examples
drop policy if exists "ai_examples owner read"  on public.ai_examples;
drop policy if exists "ai_examples owner write" on public.ai_examples;
create policy "ai_examples owner read"  on public.ai_examples
    for select using (auth.uid() = user_id);
create policy "ai_examples owner write" on public.ai_examples
    for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- review_logs
drop policy if exists "review_logs owner read"  on public.review_logs;
drop policy if exists "review_logs owner write" on public.review_logs;
create policy "review_logs owner read"  on public.review_logs
    for select using (auth.uid() = user_id);
create policy "review_logs owner write" on public.review_logs
    for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- punch_in_days
drop policy if exists "punch_in_days owner read"  on public.punch_in_days;
drop policy if exists "punch_in_days owner write" on public.punch_in_days;
create policy "punch_in_days owner read"  on public.punch_in_days
    for select using (auth.uid() = user_id);
create policy "punch_in_days owner write" on public.punch_in_days
    for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Storage bucket policies — `note-images` (bucket itself is created via UI)
-- -----------------------------------------------------------------------------
-- Path layout convention: `<user_id>/<note_id>.<ext>`. The first path
-- segment is matched against auth.uid() so users can only read/write their
-- own folder.

drop policy if exists "note-images owner read"   on storage.objects;
drop policy if exists "note-images owner write"  on storage.objects;
drop policy if exists "note-images owner update" on storage.objects;
drop policy if exists "note-images owner delete" on storage.objects;

create policy "note-images owner read" on storage.objects
    for select using (
        bucket_id = 'note-images'
        and auth.uid()::text = (storage.foldername(name))[1]
    );
create policy "note-images owner write" on storage.objects
    for insert with check (
        bucket_id = 'note-images'
        and auth.uid()::text = (storage.foldername(name))[1]
    );
create policy "note-images owner update" on storage.objects
    for update using (
        bucket_id = 'note-images'
        and auth.uid()::text = (storage.foldername(name))[1]
    );
create policy "note-images owner delete" on storage.objects
    for delete using (
        bucket_id = 'note-images'
        and auth.uid()::text = (storage.foldername(name))[1]
    );
