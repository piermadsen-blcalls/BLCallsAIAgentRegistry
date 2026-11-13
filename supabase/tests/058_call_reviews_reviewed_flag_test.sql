-- ============================================================
-- Regression test for 058_call_reviews_reviewed_flag.sql.
-- Run in the Supabase SQL Editor after 058. Everything runs inside one transaction that is
-- ROLLED BACK at the end, so it leaves no rows behind; raises on failure. Fixture calls are
-- dated 2999 so review_counts over them sees nothing real, and ids start with 'zztest-058'.
-- ============================================================
begin;

do $$ begin
  assert (select is_nullable = 'NO' and column_default = 'true'
          from information_schema.columns
          where table_schema = 'public' and table_name = 'call_reviews' and column_name = 'reviewed'),
    'call_reviews.reviewed is boolean not null default true';
end $$;

insert into canoe_calls (id, ivr_name, created_at, ascnd_transcript) values
  ('zztest-058-a', 'ASCND ZZTEST 058 Agent', '2999-01-02', 'transcript a'),
  ('zztest-058-b', 'ASCND ZZTEST 058 Agent', '2999-01-02', 'transcript b'),
  ('zztest-058-c', 'ASCND ZZTEST 058 Agent', '2999-01-02', 'transcript c');
-- a: reviewed by one reviewer, with a note.  b: reviewed by two reviewers.  c: never reviewed.
insert into call_reviews (call_id, ivr_name, reviewed_by, note) values
  ('zztest-058-a', 'ASCND ZZTEST 058 Agent', 'zz-one@example.invalid', 'caller asked twice for pricing'),
  ('zztest-058-b', 'ASCND ZZTEST 058 Agent', 'zz-one@example.invalid', null),
  ('zztest-058-b', 'ASCND ZZTEST 058 Agent', 'zz-two@example.invalid', null);

do $$ begin
  assert (select reviewed from review_counts('2999-01-01') where ivr_name = 'ASCND ZZTEST 058 Agent') = 2,
    'new rows default to reviewed: a and b';
end $$;

-- The page's un-mark: PATCH reviewed = false on the reviewer's own row.
update call_reviews set reviewed = false where call_id = 'zztest-058-a' and reviewed_by = 'zz-one@example.invalid';
update call_reviews set reviewed = false where call_id = 'zztest-058-b' and reviewed_by = 'zz-one@example.invalid';

do $$ begin
  assert (select note from call_reviews where call_id = 'zztest-058-a') = 'caller asked twice for pricing',
    'un-marking keeps the note';
  assert (select reviewable from review_counts('2999-01-01') where ivr_name = 'ASCND ZZTEST 058 Agent') = 3, 'reviewable';
  assert (select reviewed from review_counts('2999-01-01') where ivr_name = 'ASCND ZZTEST 058 Agent') = 1,
    'a is unreviewed; b stays reviewed through the second reviewer';
end $$;

-- Re-marking (the page upserts reviewed = true without a note) keeps the note too.
insert into call_reviews (call_id, ivr_name, reviewed_by, reviewed)
values ('zztest-058-a', 'ASCND ZZTEST 058 Agent', 'zz-one@example.invalid', true)
on conflict (call_id, reviewed_by) do update set reviewed = excluded.reviewed;

do $$ begin
  assert (select reviewed and note = 'caller asked twice for pricing' from call_reviews
          where call_id = 'zztest-058-a'), 're-marking keeps the note';
  assert (select reviewed from review_counts('2999-01-01') where ivr_name = 'ASCND ZZTEST 058 Agent') = 2, 're-marked';
end $$;

rollback;
