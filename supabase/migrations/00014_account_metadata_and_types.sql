-- 00014: Investment/Trust account types, account metadata, backdated openings,
--        account-owner photos, and backdated admin credits.
--
-- Adds:
--   * `investment` and `trust` values on the account_type enum.
--   * bank_accounts.member_since      — the date the member joined (backdatable).
--   * bank_accounts.owner_photo_url   — optional photo of the account owner.
--   * an `avatars` storage bucket for owner photos.
--   * admin_create_user extras: a custom account number, member-since date,
--     owner photo, and an optional backdated opening deposit.
--   * admin_credit_account RPC with an optional backdate so an admin can post a
--     credit dated in the past.

-- ── New account types ───────────────────────────────────────────────────────
-- Not referenced by any statement below (the RPC casts a runtime parameter),
-- so this is safe in a single transaction.
ALTER TYPE public.account_type ADD VALUE IF NOT EXISTS 'investment';
ALTER TYPE public.account_type ADD VALUE IF NOT EXISTS 'trust';

-- ── Account metadata ────────────────────────────────────────────────────────
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS member_since date;
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS owner_photo_url text;

-- Default member_since to the account's creation date where unset.
UPDATE public.bank_accounts SET member_since = created_at::date WHERE member_since IS NULL;

-- ── Owner-photo storage bucket ──────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users upload own avatar" ON storage.objects;
CREATE POLICY "Authenticated users upload own avatar"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Anyone can view avatars" ON storage.objects;
CREATE POLICY "Anyone can view avatars"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
CREATE POLICY "Users update own avatar"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── Account number: honour an admin-supplied number ─────────────────────────
-- The BEFORE INSERT trigger already fills account_number when it is empty, so
-- passing a value through simply skips generation.
CREATE OR REPLACE FUNCTION public.set_account_number()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_number IS NULL OR btrim(NEW.account_number) = '' THEN
    NEW.account_number := public.generate_account_number();
  END IF;
  RETURN NEW;
END;
$$;

-- ── Admin: create a user (extended) ─────────────────────────────────────────
-- Adds member-since, a custom account number, an owner photo, and an optional
-- backdated opening deposit. Dropped first because the parameter list changed.
DROP FUNCTION IF EXISTS public.admin_create_user(text, text, text, text, text, text, text, text, text, text, text, numeric);

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email text,
  p_first_name text DEFAULT NULL,
  p_last_name text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_country text DEFAULT NULL,
  p_password text DEFAULT NULL,
  p_login_pin text DEFAULT NULL,
  p_role text DEFAULT 'user',
  p_account_type text DEFAULT NULL,
  p_currency text DEFAULT 'USD',
  p_initial_balance numeric DEFAULT 0,
  p_account_number text DEFAULT NULL,
  p_member_since date DEFAULT NULL,
  p_owner_photo_url text DEFAULT NULL,
  p_backdate_days int DEFAULT 0,
  p_transaction_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  new_id uuid := gen_random_uuid();
  v_password text;
  v_pin text;
  v_username text;
  v_account_id uuid;
  v_member_since date;
  v_backdate int := greatest(coalesce(p_backdate_days, 0), 0);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can create users';
  END IF;

  IF p_email IS NULL OR position('@' in p_email) = 0 THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'A user with that email already exists';
  END IF;
  IF p_account_number IS NOT NULL AND btrim(p_account_number) <> ''
     AND EXISTS (SELECT 1 FROM public.bank_accounts WHERE account_number = btrim(p_account_number)) THEN
    RAISE EXCEPTION 'That account number is already in use';
  END IF;

  v_username := nullif(btrim(coalesce(p_username, '')), '');
  IF v_username IS NULL THEN
    v_username := split_part(p_email, '@', 1);
  END IF;
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(v_username)) LOOP
    v_username := v_username || floor(random() * 100)::int::text;
  END LOOP;

  v_pin := nullif(btrim(coalesce(p_login_pin, '')), '');
  IF v_pin IS NULL THEN
    v_pin := lpad(floor(random() * 10000)::int::text, 4, '0');
  END IF;
  v_password := coalesce(nullif(btrim(coalesce(p_password, '')), ''), 'cxt_' || v_pin);

  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, role, aud, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES (
    new_id,
    '00000000-0000-0000-0000-000000000000',
    lower(p_email),
    crypt(v_password, gen_salt('bf')),
    now(),
    jsonb_build_object(
      'first_name', p_first_name,
      'last_name', p_last_name,
      'username', v_username,
      'login_pin', v_pin
    ),
    'authenticated', 'authenticated',
    now(), now(),
    '', '', '', ''
  );

  UPDATE public.profiles SET
    email = lower(p_email),
    phone = p_phone,
    first_name = p_first_name,
    last_name = p_last_name,
    username = v_username,
    country = p_country,
    login_pin = v_pin,
    role = coalesce(nullif(p_role, '')::public.user_role, 'user'::public.user_role)
  WHERE id = new_id;

  IF p_account_type IS NOT NULL AND p_account_type <> '' THEN
    -- Member-since defaults to the backdated opening date when one is given.
    v_member_since := coalesce(
      p_member_since,
      CASE WHEN v_backdate > 0 THEN (now() - make_interval(days => v_backdate))::date END,
      now()::date
    );

    INSERT INTO public.bank_accounts (
      user_id, account_type, currency, balance, apy,
      account_number, member_since, owner_photo_url
    ) VALUES (
      new_id,
      p_account_type::public.account_type,
      coalesce(nullif(p_currency, ''), 'USD'),
      coalesce(p_initial_balance, 0),
      CASE p_account_type WHEN 'savings' THEN 4.85 WHEN 'fixed' THEN 5.40 ELSE 0 END,
      nullif(btrim(coalesce(p_account_number, '')), ''),
      v_member_since,
      nullif(btrim(coalesce(p_owner_photo_url, '')), '')
    )
    RETURNING id INTO v_account_id;

    -- Opening deposit, optionally dated in the past.
    IF coalesce(p_initial_balance, 0) > 0 THEN
      INSERT INTO public.transactions (
        account_id, type, status, amount, currency, description, created_at
      ) VALUES (
        v_account_id, 'deposit', 'completed',
        p_initial_balance, coalesce(nullif(p_currency, ''), 'USD'),
        coalesce(nullif(btrim(coalesce(p_transaction_note, '')), ''), 'Opening deposit'),
        now() - make_interval(days => v_backdate)
      );
    END IF;
  END IF;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_user(text, text, text, text, text, text, text, text, text, text, text, numeric, text, date, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, text, text, text, text, text, text, text, numeric, text, date, text, int, text) TO authenticated;

-- ── Admin: credit an account, optionally backdated ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_credit_account(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT NULL,
  p_backdate_days int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_currency text;
  v_backdate int := greatest(coalesce(p_backdate_days, 0), 0);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can credit accounts';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  SELECT currency INTO v_currency FROM public.bank_accounts WHERE id = p_account_id;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  UPDATE public.bank_accounts SET balance = balance + p_amount WHERE id = p_account_id;

  INSERT INTO public.transactions (
    account_id, type, status, amount, currency, description, created_at
  ) VALUES (
    p_account_id, 'deposit', 'completed', p_amount, v_currency,
    coalesce(nullif(btrim(coalesce(p_description, '')), ''), 'Admin Credit'),
    now() - make_interval(days => v_backdate)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_credit_account(uuid, numeric, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_credit_account(uuid, numeric, text, int) TO authenticated;

-- ── Admin: update account metadata ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_update_account(
  p_account_id uuid,
  p_account_number text DEFAULT NULL,
  p_member_since date DEFAULT NULL,
  p_owner_photo_url text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can update accounts';
  END IF;
  IF p_account_number IS NOT NULL AND btrim(p_account_number) <> ''
     AND EXISTS (SELECT 1 FROM public.bank_accounts WHERE account_number = btrim(p_account_number) AND id <> p_account_id) THEN
    RAISE EXCEPTION 'That account number is already in use';
  END IF;

  UPDATE public.bank_accounts SET
    account_number = coalesce(nullif(btrim(coalesce(p_account_number, '')), ''), account_number),
    member_since = coalesce(p_member_since, member_since),
    owner_photo_url = coalesce(nullif(btrim(coalesce(p_owner_photo_url, '')), ''), owner_photo_url)
  WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_account(uuid, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_account(uuid, text, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
