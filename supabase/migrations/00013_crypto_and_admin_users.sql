-- 00013: Crypto accounts + admin user provisioning.
--
-- Crypto:
--   * a new `crypto` value on the account_type enum, so a crypto wallet is an
--     ordinary bank_accounts row and reuses deposits/withdrawals/transfers.
--   * a crypto_assets price catalogue and crypto_holdings, a ledger of every
--     buy/sell. A wallet's `balance` is the USD value of its holdings.
--
-- Admin provisioning:
--   * admin_create_user — create a confirmed auth user + profile + optional
--     first account from the admin session (no service-role key needed).
--   * admin_set_user_password — set/replace a user's password (PIN or full
--     password) and mirror it into profiles.login_pin.

-- ── Crypto account type ─────────────────────────────────────────────────────
-- The new value is not used by any statement below (the RPC casts a runtime
-- parameter), so this is safe whether the migration is applied as one
-- transaction or statement-by-statement.
ALTER TYPE public.account_type ADD VALUE IF NOT EXISTS 'crypto';

-- ── Crypto price catalogue ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crypto_assets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol text UNIQUE NOT NULL,
  name text NOT NULL,
  price_usd numeric(18,8) NOT NULL DEFAULT 0,
  change_24h numeric(8,4) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER crypto_assets_updated_at BEFORE UPDATE ON public.crypto_assets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Crypto holdings ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crypto_holdings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  quantity numeric(24,8) NOT NULL DEFAULT 0,
  price_usd numeric(18,8) NOT NULL,
  value_usd numeric(18,2) NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crypto_holdings_user_idx ON public.crypto_holdings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crypto_holdings_account_idx ON public.crypto_holdings (account_id, symbol);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.crypto_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crypto_holdings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Crypto assets are public" ON public.crypto_assets;
CREATE POLICY "Crypto assets are public" ON public.crypto_assets
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Admin manage crypto assets" ON public.crypto_assets;
CREATE POLICY "Admin manage crypto assets" ON public.crypto_assets
  FOR ALL TO authenticated USING (get_user_role(auth.uid()) = 'admin'::public.user_role);

DROP POLICY IF EXISTS "Admin full access to holdings" ON public.crypto_holdings;
CREATE POLICY "Admin full access to holdings" ON public.crypto_holdings
  FOR ALL TO authenticated USING (get_user_role(auth.uid()) = 'admin'::public.user_role);

DROP POLICY IF EXISTS "Users view own holdings" ON public.crypto_holdings;
CREATE POLICY "Users view own holdings" ON public.crypto_holdings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own holdings" ON public.crypto_holdings;
CREATE POLICY "Users insert own holdings" ON public.crypto_holdings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- ── Seed a small price catalogue ────────────────────────────────────────────
INSERT INTO public.crypto_assets (symbol, name, price_usd, change_24h) VALUES
  ('BTC',  'Bitcoin',   68000.00,  1.25),
  ('ETH',  'Ethereum',   3500.00, -0.80),
  ('USDT', 'Tether',        1.00,  0.01),
  ('SOL',  'Solana',      165.00,  3.40),
  ('XRP',  'XRP',           0.62, -1.10),
  ('ADA',  'Cardano',       0.45,  0.60),
  ('BNB',  'BNB',         590.00,  0.35),
  ('DOGE', 'Dogecoin',      0.15,  2.10)
ON CONFLICT (symbol) DO NOTHING;

-- ── Admin: create a user ────────────────────────────────────────────────────
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
  p_initial_balance numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  new_id uuid := gen_random_uuid();
  v_password text;
  v_pin text;
  v_username text;
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

  -- Username defaults to the email local-part, de-duplicated.
  v_username := nullif(btrim(coalesce(p_username, '')), '');
  IF v_username IS NULL THEN
    v_username := split_part(p_email, '@', 1);
  END IF;
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(v_username)) LOOP
    v_username := v_username || floor(random() * 100)::int::text;
  END LOOP;

  -- Auth password: use the PIN form when a 4-digit PIN is supplied, otherwise
  -- the explicit password, otherwise a random one the admin must reset.
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

  -- handle_new_user already created the profile; complete the admin-supplied
  -- fields (and override the role when promoting).
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

  -- Optional opening account.
  IF p_account_type IS NOT NULL AND p_account_type <> '' THEN
    INSERT INTO public.bank_accounts (user_id, account_type, currency, balance, apy)
    VALUES (
      new_id,
      p_account_type::public.account_type,
      coalesce(nullif(p_currency, ''), 'USD'),
      coalesce(p_initial_balance, 0),
      CASE p_account_type WHEN 'savings' THEN 4.85 WHEN 'fixed' THEN 5.40 ELSE 0 END
    );
  END IF;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_user(text, text, text, text, text, text, text, text, text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, text, text, text, text, text, text, text, numeric) TO authenticated;

-- ── Admin: set a user's password / login PIN ────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_user_password(
  target_user_id uuid,
  new_password text,
  p_login_pin text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admins can change passwords';
  END IF;
  IF new_password IS NULL OR length(new_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE auth.users
    SET encrypted_password = crypt(new_password, gen_salt('bf')),
        updated_at = now()
  WHERE id = target_user_id;

  IF p_login_pin IS NOT NULL AND p_login_pin <> '' THEN
    UPDATE public.profiles SET login_pin = p_login_pin WHERE id = target_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_password(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_password(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
