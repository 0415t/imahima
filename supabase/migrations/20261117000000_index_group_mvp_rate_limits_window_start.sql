-- Apply after group_management_mvp, during a window that permits write blocking.
-- Ordinary CREATE INDEX is transactional. Stop on contention or any existing
-- window_start index; inspect its definition/state instead of silently skipping.
begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  existing_indexes pg_catalog.text;
begin
  select pg_catalog.string_agg(
    pg_catalog.format('%s [valid=%s, ready=%s]',
      pg_catalog.pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready),
    E'\n' order by i.indexrelid)
  into existing_indexes
  from pg_catalog.pg_index i
  where i.indrelid='public.group_mvp_rate_limits'::pg_catalog.regclass
    and exists (
      -- Dependencies also catch expression indexes and INCLUDE columns.
      select 1
      from pg_catalog.pg_depend d
      join pg_catalog.pg_attribute a
        on a.attrelid=i.indrelid and a.attnum=d.refobjsubid
      where d.classid='pg_catalog.pg_class'::pg_catalog.regclass
        and d.objid=i.indexrelid
        and d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass
        and d.refobjid=i.indrelid
        and a.attname='window_start' and not a.attisdropped
    );
  if existing_indexes is not null then
    raise exception using
      errcode='42710',
      message='Existing window_start index: inspect before applying this migration',
      detail=existing_indexes;
  end if;
end
$migration$;

-- No IF NOT EXISTS: a same-name object must cause an error, not a silent skip.
create index idx_group_mvp_rate_limits_window_start
  on public.group_mvp_rate_limits using btree (window_start);
commit;
