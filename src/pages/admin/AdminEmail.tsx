import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, Send, Star, Trash2, PenSquare, Search, RefreshCw, ArrowLeft, Reply, ReplyAll,
  Forward, Paperclip, Loader2, X, MailOpen, Mail, RotateCcw, Download, AlertCircle,
} from 'lucide-react';
import { supabase } from '@/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { BRAND } from '@/config/brand';

type Folder = 'inbox' | 'sent' | 'starred' | 'trash';

interface Attachment { filename: string; path: string; content_type: string; size: number }

interface MailRow {
  id: string;
  direction: 'inbound' | 'outbound';
  folder: 'inbox' | 'sent' | 'trash';
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  snippet: string | null;
  status: string;
  error: string | null;
  is_read: boolean;
  is_starred: boolean;
  attachments: Attachment[];
  created_at: string;
}

const SENDERS = ['support', 'info', 'admin'];

const FOLDERS: { id: Folder; label: string; icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const STATUS_STYLE: Record<string, string> = {
  sent: 'bg-blue-500/10 text-blue-600',
  delivered: 'bg-green-500/10 text-green-600',
  delayed: 'bg-yellow-500/10 text-yellow-600',
  bounced: 'bg-red-500/10 text-red-500',
  failed: 'bg-red-500/10 text-red-500',
  complained: 'bg-red-500/10 text-red-500',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitEmails(v: string) {
  return v.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function counterpart(m: MailRow) {
  if (m.direction === 'inbound') return m.from_name || m.from_address;
  return `To: ${m.to_addresses.join(', ')}`;
}

function quoteOf(m: MailRow) {
  const body = m.text_body || (m.html ? m.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n') : '');
  const who = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
  return `\n\n\nOn ${new Date(m.created_at).toLocaleString()}, ${who} wrote:\n` +
    body.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

interface ComposeState {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  replyToId?: string;
  showCc: boolean;
}

const emptyCompose: ComposeState = { from: 'support', to: '', cc: '', bcc: '', subject: '', text: '', showCc: false };

export default function AdminEmail() {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [rows, setRows] = useState<MailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [unread, setUnread] = useState(0);
  const [openMsg, setOpenMsg] = useState<MailRow | null>(null);

  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadUnread = useCallback(async () => {
    const { count } = await supabase
      .from('mail_messages')
      .select('id', { count: 'exact', head: true })
      .eq('folder', 'inbox')
      .eq('is_read', false);
    setUnread(count ?? 0);
  }, []);

  const load = useCallback(async () => {
    let q = supabase.from('mail_messages').select('*').order('created_at', { ascending: false }).limit(200);
    if (folder === 'starred') q = q.eq('is_starred', true).neq('folder', 'trash');
    else q = q.eq('folder', folder);
    const term = search.trim().replace(/[%,()]/g, ' ');
    if (term) {
      q = q.or(`subject.ilike.%${term}%,from_address.ilike.%${term}%,from_name.ilike.%${term}%,snippet.ilike.%${term}%`);
    }
    const { data, error } = await q;
    if (error) toast.error(error.message);
    setRows((data as MailRow[]) ?? []);
    setLoading(false);
    loadUnread();
  }, [folder, search, loadUnread]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // Live updates when new mail arrives or statuses change
  useEffect(() => {
    const channel = supabase
      .channel('admin-mail')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mail_messages' }, (payload) => {
        const row = payload.new as Partial<MailRow> | undefined;
        if (payload.eventType === 'INSERT' && row?.direction === 'inbound') {
          toast.info(`New email from ${row.from_name || row.from_address}`, { description: row.subject });
        }
        load();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const update = async (m: MailRow, patch: Partial<MailRow>) => {
    const { error } = await supabase.from('mail_messages').update(patch).eq('id', m.id);
    if (error) { toast.error(error.message); return false; }
    setRows((rs) => rs.map((r) => (r.id === m.id ? { ...r, ...patch } : r)));
    if (openMsg?.id === m.id) setOpenMsg({ ...m, ...patch });
    loadUnread();
    return true;
  };

  const openMessage = (m: MailRow) => {
    setOpenMsg(m);
    if (!m.is_read) update(m, { is_read: true });
  };

  const moveToTrash = async (m: MailRow) => {
    if (await update(m, { folder: 'trash' })) {
      toast.success('Moved to Trash');
      setOpenMsg(null);
      load();
    }
  };

  const restore = async (m: MailRow) => {
    if (await update(m, { folder: m.direction === 'inbound' ? 'inbox' : 'sent' })) {
      toast.success('Restored');
      setOpenMsg(null);
      load();
    }
  };

  const deleteForever = async (m: MailRow) => {
    if (!window.confirm('Delete this email permanently?')) return;
    if (m.attachments?.length) {
      await supabase.storage.from('mail_attachments').remove(m.attachments.map((a) => a.path));
    }
    const { error } = await supabase.from('mail_messages').delete().eq('id', m.id);
    if (error) { toast.error(error.message); return; }
    toast.success('Deleted');
    setOpenMsg(null);
    load();
  };

  const downloadAttachment = async (a: Attachment) => {
    const { data, error } = await supabase.storage.from('mail_attachments').createSignedUrl(a.path, 120, { download: a.filename });
    if (error || !data) { toast.error('Could not open attachment'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  // ── Compose ───────────────────────────────────────────────
  const startCompose = (preset?: Partial<ComposeState>) => {
    setCompose({ ...emptyCompose, ...preset });
    setFiles([]);
    setComposeOpen(true);
  };

  const ourLocal = (m: MailRow) => {
    const mine = m.to_addresses.concat(m.cc_addresses)
      .map((a) => a.toLowerCase().match(/([^<\s]+)@/)?.[1])
      .find((l) => l && SENDERS.includes(l));
    return mine || 'support';
  };

  const reply = (m: MailRow, all = false) => {
    const target = m.direction === 'inbound' ? (m.reply_to || m.from_address) : m.to_addresses.join(', ');
    const own = new Set(SENDERS.map((s) => `${s}@${BRAND.domain}`));
    const cc = all
      ? [...m.to_addresses, ...m.cc_addresses].filter((a) => !own.has(a.toLowerCase()) && a.toLowerCase() !== target.toLowerCase())
      : [];
    startCompose({
      from: m.direction === 'inbound' ? ourLocal(m) : m.from_address.split('@')[0],
      to: target,
      cc: cc.join(', '),
      showCc: cc.length > 0,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      text: quoteOf(m),
      replyToId: m.id,
    });
  };

  const forward = (m: MailRow) => {
    startCompose({
      from: m.direction === 'inbound' ? ourLocal(m) : m.from_address.split('@')[0],
      subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      text: `\n\n\n---------- Forwarded message ----------\nFrom: ${m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}\nDate: ${new Date(m.created_at).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to_addresses.join(', ')}\n${quoteOf(m).split('wrote:\n')[1]?.replace(/^> ?/gm, '') ?? ''}`,
    });
  };

  const send = async () => {
    const to = splitEmails(compose.to);
    if (to.length === 0) { toast.error('Add a recipient'); return; }
    if (!compose.subject.trim()) { toast.error('Add a subject'); return; }
    if (!compose.text.trim()) { toast.error('Write a message'); return; }
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > 25 * 1024 * 1024) { toast.error('Attachments must be under 25 MB in total'); return; }

    setSending(true);
    try {
      const batch = crypto.randomUUID();
      const attachments: { path: string; filename: string; content_type: string }[] = [];
      for (const f of files) {
        const path = `outbound/${batch}/${f.name.replace(/[^\w.\-]+/g, '_')}`;
        const { error } = await supabase.storage.from('mail_attachments').upload(path, f, { contentType: f.type || undefined });
        if (error) throw new Error(`Upload failed: ${f.name}`);
        attachments.push({ path, filename: f.name, content_type: f.type || 'application/octet-stream' });
      }

      const { data, error } = await supabase.functions.invoke('mail-send', {
        body: {
          from_local: compose.from,
          to,
          cc: splitEmails(compose.cc),
          bcc: splitEmails(compose.bcc),
          subject: compose.subject.trim(),
          text: compose.text,
          reply_to_id: compose.replyToId,
          attachments,
        },
      });
      if (error) {
        let msg = error.message;
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx) msg = (await ctx.json()).error ?? msg;
        } catch { /* keep default */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);

      toast.success('Email sent');
      setComposeOpen(false);
      if (folder === 'sent') load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const emailDoc = useMemo(() => {
    if (!openMsg) return '';
    const content = openMsg.html
      || `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(openMsg.text_body || '')}</pre>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}</style>
</head><body>${content}</body></html>`;
  }, [openMsg]);

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground">Email</h1>
          <p className="text-muted-foreground text-sm mt-1">Send and receive mail at @{BRAND.domain}</p>
        </div>
        <Button onClick={() => startCompose()}>
          <PenSquare className="w-4 h-4 mr-2" /> Compose
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,340px)_minmax(0,1fr)]">
        {/* Folders */}
        <div className={cn('flex md:flex-col gap-1 overflow-x-auto', openMsg && 'hidden md:flex')}>
          {FOLDERS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => { setFolder(id); setOpenMsg(null); }}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors',
                folder === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
              {id === 'inbox' && unread > 0 && (
                <span className={cn('ml-auto text-xs rounded-full px-2 py-0.5', folder === id ? 'bg-primary-foreground/20' : 'bg-primary text-primary-foreground')}>
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* List */}
        <div className={cn('rounded-xl border border-border bg-card overflow-hidden flex flex-col min-h-[60vh]', openMsg && 'hidden md:flex')}>
          <div className="flex items-center gap-2 p-3 border-b border-border">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search mail" className="pl-9 h-9" />
            </div>
            <Button variant="ghost" size="icon" onClick={() => { setLoading(true); load(); }} title="Refresh">
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[70vh]">
            {loading && rows.length === 0 ? (
              <div className="p-3 space-y-3">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                <MailOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                No emails here
              </div>
            ) : (
              rows.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => openMessage(m)}
                  className={cn(
                    'w-full text-left px-4 py-3 border-b border-border last:border-0 transition-colors hover:bg-muted/60',
                    openMsg?.id === m.id && 'bg-muted',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {!m.is_read && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                    <span className={cn('text-sm truncate flex-1', !m.is_read ? 'font-bold text-foreground' : 'text-foreground')}>
                      {counterpart(m)}
                    </span>
                    {m.is_starred && <Star className="w-3 h-3 fill-yellow-400 text-yellow-400 shrink-0" />}
                    {m.attachments?.length > 0 && <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />}
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(m.created_at)}</span>
                  </div>
                  <div className={cn('text-sm truncate mt-0.5', !m.is_read ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                    {m.subject || '(no subject)'}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">{m.snippet}</div>
                  {m.direction === 'outbound' && m.status !== 'sent' && (
                    <span className={cn('inline-block mt-1 text-[10px] font-semibold uppercase rounded px-1.5 py-0.5', STATUS_STYLE[m.status] ?? 'bg-muted')}>
                      {m.status}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Reader */}
        <div className={cn('rounded-xl border border-border bg-card min-h-[60vh] flex-col', openMsg ? 'flex' : 'hidden md:flex')}>
          {!openMsg ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <div className="text-center">
                <Mail className="w-10 h-10 mx-auto mb-2 opacity-30" />
                Select an email to read
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 p-2 border-b border-border flex-wrap">
                <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpenMsg(null)}>
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => reply(openMsg)}><Reply className="w-4 h-4 mr-1" />Reply</Button>
                <Button variant="ghost" size="sm" onClick={() => reply(openMsg, true)}><ReplyAll className="w-4 h-4 mr-1" />All</Button>
                <Button variant="ghost" size="sm" onClick={() => forward(openMsg)}><Forward className="w-4 h-4 mr-1" />Forward</Button>
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="icon" title={openMsg.is_starred ? 'Unstar' : 'Star'} onClick={() => update(openMsg, { is_starred: !openMsg.is_starred })}>
                    <Star className={cn('w-4 h-4', openMsg.is_starred && 'fill-yellow-400 text-yellow-400')} />
                  </Button>
                  {openMsg.direction === 'inbound' && (
                    <Button variant="ghost" size="icon" title="Mark unread" onClick={() => { update(openMsg, { is_read: false }); setOpenMsg(null); }}>
                      <Mail className="w-4 h-4" />
                    </Button>
                  )}
                  {openMsg.folder === 'trash' ? (
                    <>
                      <Button variant="ghost" size="icon" title="Restore" onClick={() => restore(openMsg)}><RotateCcw className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" title="Delete forever" onClick={() => deleteForever(openMsg)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="icon" title="Move to Trash" onClick={() => moveToTrash(openMsg)}><Trash2 className="w-4 h-4" /></Button>
                  )}
                </div>
              </div>

              <div className="p-4 border-b border-border space-y-2">
                <h2 className="text-lg font-bold text-foreground break-words">{openMsg.subject || '(no subject)'}</h2>
                <div className="text-sm">
                  <span className="font-semibold text-foreground">{openMsg.from_name || openMsg.from_address}</span>
                  {openMsg.from_name && <span className="text-muted-foreground"> &lt;{openMsg.from_address}&gt;</span>}
                </div>
                <div className="text-xs text-muted-foreground break-words">
                  To: {openMsg.to_addresses.join(', ')}
                  {openMsg.cc_addresses.length > 0 && <> · Cc: {openMsg.cc_addresses.join(', ')}</>}
                  {openMsg.bcc_addresses.length > 0 && <> · Bcc: {openMsg.bcc_addresses.join(', ')}</>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {new Date(openMsg.created_at).toLocaleString()}
                  {openMsg.direction === 'outbound' && (
                    <Badge variant="secondary" className={cn('uppercase text-[10px]', STATUS_STYLE[openMsg.status])}>{openMsg.status}</Badge>
                  )}
                </div>
                {openMsg.error && (
                  <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg p-2">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {openMsg.error}
                  </div>
                )}
                {openMsg.attachments?.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {openMsg.attachments.map((a) => (
                      <button
                        key={a.path}
                        type="button"
                        onClick={() => downloadAttachment(a)}
                        className="flex items-center gap-2 text-xs border border-border rounded-lg px-3 py-2 hover:bg-muted"
                      >
                        <Paperclip className="w-3 h-3" />
                        <span className="max-w-[160px] truncate">{a.filename}</span>
                        <span className="text-muted-foreground">{fmtSize(a.size)}</span>
                        <Download className="w-3 h-3" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <iframe
                title="Email content"
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                srcDoc={emailDoc}
                className="flex-1 w-full min-h-[50vh] bg-white rounded-b-xl"
              />
            </>
          )}
        </div>
      </div>

      {/* Compose dialog */}
      <Dialog open={composeOpen} onOpenChange={(o) => !sending && setComposeOpen(o)}>
        <DialogContent className="max-w-2xl max-h-[95vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{compose.replyToId ? 'Reply' : 'New email'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-14 shrink-0">From</span>
              <Select value={compose.from} onValueChange={(v) => setCompose({ ...compose, from: v })}>
                <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SENDERS.map((s) => (
                    <SelectItem key={s} value={s}>{BRAND.name} &lt;{s}@{BRAND.domain}&gt;</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-14 shrink-0">To</span>
              <Input value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="name@example.com, …" />
              {!compose.showCc && (
                <Button variant="ghost" size="sm" onClick={() => setCompose({ ...compose, showCc: true })}>Cc/Bcc</Button>
              )}
            </div>

            {compose.showCc && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground w-14 shrink-0">Cc</span>
                  <Input value={compose.cc} onChange={(e) => setCompose({ ...compose, cc: e.target.value })} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground w-14 shrink-0">Bcc</span>
                  <Input value={compose.bcc} onChange={(e) => setCompose({ ...compose, bcc: e.target.value })} />
                </div>
              </>
            )}

            <Input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} placeholder="Subject" />

            <Textarea
              value={compose.text}
              onChange={(e) => setCompose({ ...compose, text: e.target.value })}
              placeholder="Write your message…"
              className="min-h-[260px] font-sans"
            />

            {files.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="flex items-center gap-1 text-xs border border-border rounded-lg px-2 py-1">
                    <Paperclip className="w-3 h-3" /> <span className="max-w-[160px] truncate">{f.name}</span>
                    <span className="text-muted-foreground">{fmtSize(f.size)}</span>
                    <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="ml-1 hover:text-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                setFiles([...files, ...Array.from(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={sending}>
                <Paperclip className="w-4 h-4 mr-2" /> Attach
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setComposeOpen(false)} disabled={sending}>Discard</Button>
                <Button onClick={send} disabled={sending}>
                  {sending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                  Send
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
