// mail-send — admin-only outbound email via Resend.
// Body: { from_local, to[], cc[], bcc[], subject, text, reply_to_id?, attachments?: [{ path, filename, content_type }] }
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { encode as b64encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_NAME = Deno.env.get('SMTP_FROM_NAME') ?? 'Westfield Trust';
const MAIL_DOMAIN = Deno.env.get('MAIL_DOMAIN') ?? 'westfieldtrustbnk.com';
const MAIL_SENDERS = (Deno.env.get('MAIL_SENDERS') ?? 'support,info,admin')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text: string) {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;">${body}</div>
</body></html>`;
}

interface AttachmentRef { path: string; filename: string; content_type?: string }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Only signed-in admins may send
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', userData.user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Admin only' }, 403);

    if (!RESEND_API_KEY) return json({ error: 'Email is not configured (RESEND_API_KEY missing)' }, 500);

    const body = await req.json();
    const fromLocal = String(body.from_local ?? MAIL_SENDERS[0]).toLowerCase();
    if (!MAIL_SENDERS.includes(fromLocal)) return json({ error: 'Sender address not allowed' }, 400);

    const to = cleanList(body.to);
    const cc = cleanList(body.cc);
    const bcc = cleanList(body.bcc);
    const subject = String(body.subject ?? '').trim();
    const text = String(body.text ?? '');

    if (to.length === 0) return json({ error: 'Add at least one recipient' }, 400);
    const bad = [...to, ...cc, ...bcc].find((e) => !EMAIL_RE.test(e));
    if (bad) return json({ error: `Invalid email address: ${bad}` }, 400);
    if (!subject) return json({ error: 'Subject is required' }, 400);
    if (!text.trim()) return json({ error: 'Message is empty' }, 400);

    // Threading headers when replying
    const headers: Record<string, string> = {};
    let inReplyTo: string | null = null;
    if (body.reply_to_id) {
      const { data: orig } = await admin.from('mail_messages').select('message_id').eq('id', body.reply_to_id).single();
      if (orig?.message_id) {
        inReplyTo = orig.message_id;
        headers['In-Reply-To'] = orig.message_id;
        headers['References'] = orig.message_id;
      }
    }

    // Attachments were uploaded to storage by the browser; read and base64 them
    const refs: AttachmentRef[] = Array.isArray(body.attachments) ? body.attachments : [];
    const resendAttachments: { filename: string; content: string }[] = [];
    const storedAttachments: { filename: string; path: string; content_type: string; size: number }[] = [];
    let total = 0;
    for (const a of refs) {
      if (!a?.path?.startsWith('outbound/')) continue;
      const { data: file, error } = await admin.storage.from('mail_attachments').download(a.path);
      if (error || !file) return json({ error: `Could not read attachment ${a.filename}` }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      total += bytes.byteLength;
      if (total > 25 * 1024 * 1024) return json({ error: 'Attachments exceed 25 MB' }, 400);
      resendAttachments.push({ filename: a.filename, content: b64encode(bytes) });
      storedAttachments.push({
        filename: a.filename, path: a.path,
        content_type: a.content_type || file.type || 'application/octet-stream', size: bytes.byteLength,
      });
    }

    const fromAddress = `${fromLocal}@${MAIL_DOMAIN}`;
    const html = textToHtml(text);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${FROM_NAME} <${fromAddress}>`,
        to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined,
        reply_to: fromAddress,
        subject, html, text,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: resendAttachments.length ? resendAttachments : undefined,
      }),
    });
    const result = await res.json().catch(() => ({}));

    const { data: saved } = await admin.from('mail_messages').insert({
      direction: 'outbound',
      folder: 'sent',
      from_address: fromAddress,
      from_name: FROM_NAME,
      to_addresses: to,
      cc_addresses: cc,
      bcc_addresses: bcc,
      reply_to: fromAddress,
      subject,
      html,
      text_body: text,
      snippet: text.replace(/\s+/g, ' ').slice(0, 160),
      in_reply_to: inReplyTo,
      provider_id: res.ok ? result.id ?? null : null,
      status: res.ok ? 'sent' : 'failed',
      error: res.ok ? null : (result.message ?? 'Send failed'),
      is_read: true,
      attachments: storedAttachments,
      sent_by: userData.user.id,
    }).select('id').single();

    if (!res.ok) return json({ error: result.message ?? 'Send failed', id: saved?.id }, 502);
    return json({ success: true, id: saved?.id, provider_id: result.id });
  } catch (err) {
    console.error('mail-send error:', err);
    return json({ error: String(err) }, 500);
  }
});
