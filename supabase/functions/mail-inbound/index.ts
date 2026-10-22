// mail-inbound — Resend webhook receiver (deploy with --no-verify-jwt).
// Handles: email.received (stores into Inbox) and delivery events for sent mail.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { decode as b64decode, encode as b64encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ok = (body: unknown = { ok: true }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Svix signature check: HMAC-SHA256 over "id.timestamp.body" with the base64 secret
async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!WEBHOOK_SECRET) return false;
  const id = req.headers.get('svix-id');
  const ts = req.headers.get('svix-timestamp');
  const sigHeader = req.headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw', b64decode(WEBHOOK_SECRET.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
  const expected = b64encode(new Uint8Array(mac));
  return sigHeader.split(' ').some((part) => {
    const [ver, sig] = part.split(',');
    return ver === 'v1' && sig === expected;
  });
}

function parseAddress(v: string): { address: string; name: string | null } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  return { name: null, address: v.trim().toLowerCase() };
}

function asList(v: unknown): string[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

function safeName(s: string) {
  return s.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

async function resendGet(path: string) {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend ${path} → ${res.status}`);
  return res.json();
}

serve(async (req) => {
  if (req.method !== 'POST') return ok({ error: 'Method not allowed' }, 405);

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return ok({ error: 'Invalid signature' }, 401);

  const event = JSON.parse(raw);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const type: string = event?.type ?? '';
  const data = event?.data ?? {};

  try {
    // Delivery status for mail we sent
    const statusMap: Record<string, string> = {
      'email.delivered': 'delivered',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.delivery_delayed': 'delayed',
      'email.failed': 'failed',
    };
    if (statusMap[type]) {
      if (data.email_id) {
        await admin.from('mail_messages')
          .update({ status: statusMap[type] })
          .eq('provider_id', data.email_id)
          .eq('direction', 'outbound');
      }
      return ok();
    }

    if (type !== 'email.received') return ok({ ignored: type });

    const emailId: string = data.email_id;
    if (!emailId) return ok({ error: 'No email_id' }, 400);

    // Already stored? (webhooks can be retried)
    const { data: existing } = await admin.from('mail_messages').select('id').eq('provider_id', emailId).maybeSingle();
    if (existing) return ok({ duplicate: true });

    const email = await resendGet(`/emails/receiving/${emailId}?html_format=data_uri`);

    // Save real (non-inline) attachments into private storage
    const attachments: { filename: string; path: string; content_type: string; size: number }[] = [];
    try {
      const list = await resendGet(`/emails/receiving/${emailId}/attachments`);
      for (const a of list?.data ?? []) {
        if (a.content_disposition === 'inline' && a.content_id) continue; // already embedded in html
        if (!a.download_url) continue;
        const file = await fetch(a.download_url);
        if (!file.ok) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = `inbound/${emailId}/${a.id}-${safeName(a.filename ?? 'file')}`;
        const { error } = await admin.storage.from('mail_attachments').upload(path, bytes, {
          contentType: a.content_type ?? 'application/octet-stream', upsert: true,
        });
        if (!error) {
          attachments.push({
            filename: a.filename ?? 'file', path,
            content_type: a.content_type ?? 'application/octet-stream', size: bytes.byteLength,
          });
        }
      }
    } catch (e) {
      console.error('attachment fetch failed:', e);
    }

    const from = parseAddress(String(email.from ?? data.from ?? ''));
    const text: string = email.text ?? '';
    const replyTo = asList(email.reply_to)[0] ?? null;

    await admin.from('mail_messages').insert({
      direction: 'inbound',
      folder: 'inbox',
      from_address: from.address,
      from_name: from.name,
      to_addresses: asList(email.to ?? data.to),
      cc_addresses: asList(email.cc),
      bcc_addresses: asList(email.bcc),
      reply_to: replyTo ? parseAddress(replyTo).address : null,
      subject: email.subject ?? data.subject ?? '(no subject)',
      html: email.html ?? null,
      text_body: text || null,
      snippet: (text || String(email.html ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ').trim().slice(0, 160),
      message_id: email.message_id ?? data.message_id ?? null,
      provider_id: emailId,
      status: 'received',
      attachments,
      created_at: email.created_at ?? new Date().toISOString(),
    });

    // Bell notification for every admin
    const { data: admins } = await admin.from('profiles').select('id').eq('role', 'admin');
    if (admins?.length) {
      await admin.from('notifications').insert(admins.map((a: { id: string }) => ({
        user_id: a.id,
        title: 'New email received',
        body: `${from.name || from.address}: ${email.subject ?? '(no subject)'}`,
        type: 'message',
        metadata: { link: '/admin/email' },
      })));
    }

    return ok();
  } catch (err) {
    console.error('mail-inbound error:', err);
    // 500 makes Resend retry later
    return ok({ error: String(err) }, 500);
  }
});
