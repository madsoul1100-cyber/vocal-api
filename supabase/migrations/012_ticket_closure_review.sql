-- Worker soft-close queue flag (CS reviews before stage = closed)
alter table tickets
  add column if not exists needs_closure_review boolean not null default false;

create index if not exists tickets_closure_review_idx
  on tickets (organization_id, needs_closure_review)
  where needs_closure_review = true;
