
-- 自動OFFのCronジョブを毎分実行する
-- 既存ジョブがある場合は重複登録しない

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'auto-expire-free-status'
  ) THEN
    PERFORM cron.schedule(
      'auto-expire-free-status',
      '* * * * *',
      'SELECT public.auto_expire_free_status();'
    );
  END IF;
END;
$$;
