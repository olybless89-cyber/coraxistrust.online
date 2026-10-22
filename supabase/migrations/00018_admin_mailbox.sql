-- 00018: Admin email client (real external email via Resend).
-- Inbound mail arrives through the `mail-inbound` Edge Function (Resend webhook);
-- outbound mail is sent by the `mail-send` Edge Function. Admin-only.

CREATE TABLE IF NOT EXISTS public.mail_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder        text NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent', 'trash')),
  from_address  text NOT NULL,
  from_name     text,
  to_addresses  text[] NOT NULL DEFAULT '{}',
  cc_addresses  text[] NOT NULL DEFAULT '{}',
  bcc_addresses text[] NOT NULL DEFAULT '{}',
  reply_to      text,
  subject       text NOT NULL DEFAULT '',
  html          text,
  text_body     text,
  snippet       text,
  message_id    text,
  in_reply_to   text,
  provider_id   text UNIQUE,
  status        text NOT NULL DEFAULT 'received',
  error         text,
  is_read       boolean NOT NULL DEFAULT false,
  is_starred    boolean NOT NULL DEFAULT false,
  attachments   jsonb NOT NULL DEFAULT '[]',
  sent_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_messages_folder_idx
  ON public.mail_messages (folder, created_at DESC);

ALTER TABLE public.mail_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access to mail" ON public.mail_messages;
CREATE POLICY "Admin full access to mail" ON public.mail_messages FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = 'admin'::public.user_role)
  WITH CHECK (get_user_role(auth.uid()) = 'admin'::public.user_role);

-- Live inbox updates
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mail_messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mail_messages;
  END IF;
END $$;

-- Private bucket for inbound and outbound attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('mail_attachments', 'mail_attachments', false, 26214400)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Admin read mail attachments" ON storage.objects;
CREATE POLICY "Admin read mail attachments" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'mail_attachments' AND get_user_role(auth.uid()) = 'admin'::public.user_role);

DROP POLICY IF EXISTS "Admin upload mail attachments" ON storage.objects;
CREATE POLICY "Admin upload mail attachments" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mail_attachments' AND get_user_role(auth.uid()) = 'admin'::public.user_role);

DROP POLICY IF EXISTS "Admin delete mail attachments" ON storage.objects;
CREATE POLICY "Admin delete mail attachments" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'mail_attachments' AND get_user_role(auth.uid()) = 'admin'::public.user_role);
