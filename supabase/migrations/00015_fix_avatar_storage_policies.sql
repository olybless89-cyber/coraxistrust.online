-- 00015: Fix avatar storage permissions.
--
-- 00014 scoped uploads to `avatars/<auth.uid()>/...`, but the admin create-user
-- flow uploads the owner photo *before* the account exists and namespaces it by
-- a random id, so the upload was rejected with "new row violates row-level
-- security policy". Admins now get full access to the bucket, and users keep
-- access to their own folder plus the ability to delete their own avatar.

DROP POLICY IF EXISTS "Authenticated users upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view avatars" ON storage.objects;
DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Admins manage avatars" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own avatar" ON storage.objects;

-- Admins (who provision accounts) can manage any object in the bucket.
CREATE POLICY "Admins manage avatars"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND get_user_role(auth.uid()) = 'admin'::public.user_role)
  WITH CHECK (bucket_id = 'avatars' AND get_user_role(auth.uid()) = 'admin'::public.user_role);

-- A signed-in user can upload into their own folder.
CREATE POLICY "Authenticated users upload own avatar"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users update own avatar"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users delete own avatar"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Avatars are served straight into an <img>, so the bucket is public-read.
CREATE POLICY "Anyone can view avatars"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'avatars');
