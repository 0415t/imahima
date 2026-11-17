-- pg_cron拡張の有効化
-- 20261106000001_schedule_auto_expire.sql が参照する cron.job / cron.schedule の前提。
-- ローカルSupabaseでは pg_cron はプリロード済みだが拡張は自動作成されないため、
-- スケジュール登録より前に有効化する。
-- リモートでは既に有効（pg_catalog配置）のため、IF NOT EXISTS で冪等。
CREATE EXTENSION IF NOT EXISTS pg_cron
WITH SCHEMA pg_catalog;
