import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bitcoin, TrendingUp, TrendingDown, Wallet, Plus, ArrowLeftRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import {
  getCryptoAssets,
  getCryptoPositions,
  getOrCreateCryptoWallet,
  buyCrypto,
  sellCrypto,
} from '@/services/api';
import type { BankAccount, CryptoAsset, CryptoPosition } from '@/types';
import { toast } from 'sonner';

export default function CryptoPage() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState<BankAccount | null>(null);
  const [assets, setAssets] = useState<CryptoAsset[]>([]);
  const [positions, setPositions] = useState<CryptoPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Buy / sell dialog state
  const [buyAsset, setBuyAsset] = useState<CryptoAsset | null>(null);
  const [sellPosition, setSellPosition] = useState<CryptoPosition | null>(null);
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [w, a, p] = await Promise.all([
        getOrCreateCryptoWallet(user.id),
        getCryptoAssets(),
        getCryptoPositions(user.id),
      ]);
      setWallet(w);
      setAssets(a);
      setPositions(p);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load crypto account');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const holdingsValue = positions.reduce((s, p) => s + p.value_usd, 0);
  const walletBalance = wallet?.balance ?? 0;
  const portfolioTotal = holdingsValue + walletBalance;

  const openBuy = (asset: CryptoAsset) => { setBuyAsset(asset); setAmount(''); };
  const openSell = (position: CryptoPosition) => { setSellPosition(position); setQuantity(''); };

  const submitBuy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !wallet || !buyAsset) return;
    const amt = parseFloat(amount);
    if (!(amt > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (amt > walletBalance) { toast.error('Insufficient wallet balance. Fund your crypto wallet first.'); return; }
    setBusy(true);
    try {
      await buyCrypto({ userId: user.id, accountId: wallet.id, symbol: buyAsset.symbol, amountUsd: amt });
      toast.success(`Bought ${buyAsset.symbol}`);
      setBuyAsset(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBusy(false);
    }
  };

  const submitSell = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !wallet || !sellPosition) return;
    const qty = parseFloat(quantity);
    if (!(qty > 0)) { toast.error('Enter a quantity greater than zero'); return; }
    if (qty > sellPosition.quantity) { toast.error('You do not hold that much'); return; }
    setBusy(true);
    try {
      await sellCrypto({ userId: user.id, accountId: wallet.id, symbol: sellPosition.symbol, quantity: qty });
      toast.success(`Sold ${sellPosition.symbol}`);
      setSellPosition(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Sale failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground flex items-center gap-2">
            <Bitcoin className="w-6 h-6 text-primary" /> Crypto Account
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Buy, sell and track digital assets</p>
        </div>
        <Button variant="ghost" className="border border-border" onClick={load} disabled={busy}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Portfolio summary */}
      <div className="rounded-2xl bg-gradient-to-br from-[#0d9488] to-[#0c2a26] p-8 text-white teal-glow">
        <div className="text-white/60 text-sm mb-1">Total Crypto Portfolio</div>
        <div className="text-4xl font-extrabold mb-6">
          ${portfolioTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-white/60">Holdings Value</div>
            <div className="font-semibold text-lg">${holdingsValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
          <div>
            <div className="text-white/60">Cash Balance</div>
            <div className="font-semibold text-lg">${walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
        </div>
        <div className="mt-6">
          <Link to="/dashboard/money">
            <Button size="sm" className="bg-white/15 hover:bg-white/25 text-white border-0">
              <Wallet className="w-4 h-4 mr-2" /> Fund wallet
            </Button>
          </Link>
        </div>
      </div>

      {/* Markets */}
      <div className="glass-card rounded-2xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-bold text-foreground">Markets</h2>
          <span className="text-xs text-muted-foreground">{assets.length} assets</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="text-xs text-muted-foreground uppercase tracking-wider border-b border-border bg-muted/30">
                <th className="text-left px-6 py-3">Asset</th>
                <th className="text-right px-6 py-3">Price</th>
                <th className="text-right px-6 py-3">24h</th>
                <th className="text-right px-6 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-muted-foreground">No assets available</td></tr>
              ) : assets.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                        {a.symbol.slice(0, 1)}
                      </div>
                      <div>
                        <div className="font-semibold text-sm text-foreground">{a.symbol}</div>
                        <div className="text-xs text-muted-foreground">{a.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm font-semibold text-right">
                    ${a.price_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-6 py-4 text-sm text-right">
                    <span className={`inline-flex items-center gap-1 font-medium ${a.change_24h >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                      {a.change_24h >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                      {a.change_24h >= 0 ? '+' : ''}{a.change_24h.toFixed(2)}%
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 h-8" onClick={() => openBuy(a)}>
                      <Plus className="w-3 h-3 mr-1" /> Buy
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Holdings */}
      <div className="glass-card rounded-2xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-bold text-foreground">Your Holdings</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="text-xs text-muted-foreground uppercase tracking-wider border-b border-border bg-muted/30">
                <th className="text-left px-6 py-3">Asset</th>
                <th className="text-right px-6 py-3">Quantity</th>
                <th className="text-right px-6 py-3">Price</th>
                <th className="text-right px-6 py-3">Value</th>
                <th className="text-right px-6 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">No holdings yet. Buy your first asset above.</td></tr>
              ) : positions.map((p) => (
                <tr key={p.symbol} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-sm text-foreground">{p.symbol}</div>
                    <div className="text-xs text-muted-foreground">{p.name}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-right font-mono">{p.quantity.toFixed(6)}</td>
                  <td className="px-6 py-4 text-sm text-right">${p.price_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-6 py-4 text-sm text-right font-semibold">${p.value_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  <td className="px-6 py-4 text-right">
                    <Button size="sm" variant="ghost" className="border border-border h-8" onClick={() => openSell(p)}>
                      <ArrowLeftRight className="w-3 h-3 mr-1" /> Sell
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Buy dialog */}
      <Dialog open={!!buyAsset} onOpenChange={(open) => !open && setBuyAsset(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Buy {buyAsset?.symbol}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitBuy} className="space-y-4">
            <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Market price</span>
              <span className="font-semibold">${buyAsset?.price_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Amount (USD)</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold">$</span>
                <Input type="number" min="0.01" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="bg-white border-border h-12 pl-8 text-lg font-semibold" required />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Wallet balance: ${walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                {buyAsset && amount && parseFloat(amount) > 0 ? ` · ≈ ${(parseFloat(amount) / buyAsset.price_usd).toFixed(6)} ${buyAsset.symbol}` : ''}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setBuyAsset(null)} className="border border-border">Cancel</Button>
              <Button type="submit" disabled={busy} className="bg-primary text-primary-foreground hover:bg-primary/90">
                {busy ? 'Buying...' : 'Buy'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sell dialog */}
      <Dialog open={!!sellPosition} onOpenChange={(open) => !open && setSellPosition(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sell {sellPosition?.symbol}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitSell} className="space-y-4">
            <div className="rounded-xl bg-muted/40 border border-border p-4 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">You hold</span>
              <span className="font-semibold">{sellPosition?.quantity.toFixed(6)} {sellPosition?.symbol}</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quantity</label>
              <Input type="number" min="0.00000001" step="any" placeholder="0.000000" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="bg-white border-border h-12 text-lg font-semibold" required />
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-muted-foreground">
                  {sellPosition && quantity && parseFloat(quantity) > 0
                    ? `≈ $${(parseFloat(quantity) * sellPosition.price_usd).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                    : 'Enter an amount to sell'}
                </p>
                <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setQuantity(sellPosition ? String(sellPosition.quantity) : '')}>
                  Sell all
                </button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSellPosition(null)} className="border border-border">Cancel</Button>
              <Button type="submit" disabled={busy} className="bg-primary text-primary-foreground hover:bg-primary/90">
                {busy ? 'Selling...' : 'Sell'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
