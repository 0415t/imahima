
-- 期限切れの暇状態を自動的にOFFにする関数
CREATE OR REPLACE FUNCTION public.auto_expire_free_status()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET
    is_free = false,
    free_until = NULL
  WHERE
    is_free = true
    AND free_until IS NOT NULL
    AND free_until <= now();
END;
$$;

-- デフォルトの実行権限を取り消す
REVOKE ALL ON FUNCTION public.auto_expire_free_status()
FROM PUBLIC, anon, authenticated;

-- バックエンド用ロールにのみ実行権限を付与
GRANT EXECUTE ON FUNCTION public.auto_expire_free_status()
TO service_role;
