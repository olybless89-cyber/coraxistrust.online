-- 00017: Guard admin role changes.
--
-- The Users table let an admin toggle any profile's role with a direct table
-- update, including their own. Demoting yourself drops role to 'user', which
-- locks you out of the whole admin portal — the Create User button and every
-- other admin page disappear, with no way back in from the UI.
--
-- Role changes now go through this RPC, which refuses to remove the caller's own
-- admin access and refuses to demote the last remaining admin.

CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  target_user_id uuid,
  new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_role public.user_role;
  v_admins int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can change roles';
  END IF;
  IF new_role NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'Role must be user or admin';
  END IF;
  IF target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  v_role := new_role::public.user_role;

  IF v_role <> 'admin' THEN
    SELECT count(*) INTO v_admins FROM public.profiles WHERE role = 'admin';
    IF v_admins <= 1 THEN
      RAISE EXCEPTION 'At least one admin must remain';
    END IF;
  END IF;

  UPDATE public.profiles SET role = v_role WHERE id = target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, text) TO authenticated;

-- Safety net: the admin account must always be able to reach the portal.
UPDATE public.profiles SET role = 'admin' WHERE email = 'admin@coraxistrust.online';
