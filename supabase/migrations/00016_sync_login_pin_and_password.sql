-- 00016: Keep the login PIN and the Supabase auth password in sync.
--
-- The sign-in page always authenticates with `cxt_<PIN>` as the password
-- (see Login.tsx / Register.tsx). But two admin actions wrote only one side:
--
--   * admin_set_user_password set a custom auth password while the profile kept
--     the old login_pin — so the PIN stopped working the moment a password was
--     set ("incorrect pin").
--   * setUserLoginPin wrote profiles.login_pin directly, never touching
--     auth.users — so a PIN reset never took effect.
--
-- Both now write auth.users.encrypted_password = crypt('cxt_' || pin) so the PIN
-- the admin sets is always the PIN the user can sign in with. A custom password
-- still wins when no PIN is supplied.

-- Admin: set a password and/or PIN, keeping both in sync.
CREATE OR REPLACE FUNCTION public.admin_set_user_password(
  target_user_id uuid,
  new_password text,
  p_login_pin text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_pin text := nullif(btrim(coalesce(p_login_pin, '')), '');
  v_password text := nullif(btrim(coalesce(new_password, '')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can change passwords';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- A PIN is the primary credential: when one is supplied it becomes the auth
  -- password so the sign-in page can authenticate with it.
  IF v_pin IS NOT NULL THEN
    IF v_pin !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'Login PIN must be exactly 4 digits';
    END IF;
    v_password := 'cxt_' || v_pin;
  END IF;

  IF v_password IS NULL OR length(v_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters';
  END IF;

  UPDATE auth.users
    SET encrypted_password = crypt(v_password, gen_salt('bf')),
        updated_at = now()
  WHERE id = target_user_id;

  IF v_pin IS NOT NULL THEN
    UPDATE public.profiles SET login_pin = v_pin WHERE id = target_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_password(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_password(uuid, text, text) TO authenticated;

-- Admin: reset just the login PIN. Also rewrites the auth password so the new
-- PIN works immediately.
CREATE OR REPLACE FUNCTION public.admin_set_login_pin(
  target_user_id uuid,
  new_pin text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_pin text := nullif(btrim(coalesce(new_pin, '')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can change login PINs';
  END IF;
  IF v_pin IS NULL OR v_pin !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Login PIN must be exactly 4 digits';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE auth.users
    SET encrypted_password = crypt('cxt_' || v_pin, gen_salt('bf')),
        updated_at = now()
  WHERE id = target_user_id;

  UPDATE public.profiles SET login_pin = v_pin WHERE id = target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_login_pin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_login_pin(uuid, text) TO authenticated;

-- One-time repair: any account whose auth password no longer matches its login
-- PIN is put back in sync, so a PIN that was reset (or an account whose password
-- an admin replaced) can sign in again. Accounts already in sync are untouched.
UPDATE auth.users u
   SET encrypted_password = crypt('cxt_' || p.login_pin, gen_salt('bf')),
       updated_at = now()
  FROM public.profiles p
 WHERE u.id = p.id
   AND p.login_pin IS NOT NULL
   AND p.login_pin ~ '^[0-9]{4}$'
   AND u.encrypted_password <> crypt('cxt_' || p.login_pin, u.encrypted_password);
