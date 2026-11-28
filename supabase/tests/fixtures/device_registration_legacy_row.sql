INSERT INTO auth.users(id) VALUES ('11000000-0000-0000-0000-000000000024');
INSERT INTO public.user_device_tokens(id, user_id, expo_push_token, platform, device_name, created_at, updated_at)
VALUES ('12000000-0000-0000-0000-000000000024', '11000000-0000-0000-0000-000000000024',
    'legacy-before-recovery-ddl', 'ios', 'legacy', '2026-11-23T00:00:00Z', '2026-11-24T00:00:00Z');
