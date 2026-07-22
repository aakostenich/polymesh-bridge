import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  api,
  type BridgeEvent,
  type EthAccount,
  type PolyAccount,
  type StatusResponse,
  type TransferRecord,
  type TransferStatus,
} from './lib/api';
import {
  bridgeToPolymesh,
  formatPolyx,
  shortAddr,
  signerFromPrivateKey,
} from './lib/eth';

type Tab = 'home' | 'bridge' | 'portfolio' | 'activity' | 'network' | 'docs';
type Direction = 'poly_to_eth' | 'eth_to_poly';
type Theme = 'dark' | 'light';
type LogLevel = 'info' | 'ok' | 'err' | 'wait';

type Activity = {
  id: string;
  level: LogLevel;
  message: string;
  at: number;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'bridge', label: 'Bridge' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'activity', label: 'Activity' },
  { id: 'network', label: 'Network' },
  { id: 'docs', label: 'Docs' },
];

function nowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadTheme(): Theme {
  const saved = localStorage.getItem('polyx-bridge-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

/* ─── Icons ────────────────────────────────────────────────────────────── */

function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 8.5h10M7 15.5h10M9.5 5l-2 7 2 7M14.5 5l2 7-2 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 10V4m0 0L4 7m3-3 3 3M17 14v6m0 0 3-3m-3 3-3-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M5 19l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 14.5A7.5 7.5 0 0 1 9.5 4 7.5 7.5 0 1 0 20 14.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="alert-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-5.25a.75.75 0 001.5 0v-4.5a.75.75 0 00-1.5 0v4.5zM10 14.5a1 1 0 100 2 1 1 0 000-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3 5 6.5v5.2c0 4.3 2.9 7.4 7 8.8 4.1-1.4 7-4.5 7-8.8V6.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 17l9 5 9-5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─── App ──────────────────────────────────────────────────────────────── */

export function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [polyAccounts, setPolyAccounts] = useState<PolyAccount[]>([]);
  const [ethAccounts, setEthAccounts] = useState<EthAccount[]>([]);
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [trackedIntentId, setTrackedIntentId] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>('poly_to_eth');
  const [amount, setAmount] = useState('10');
  const [polySender, setPolySender] = useState('//Bob');
  const [ethAccountIdx, setEthAccountIdx] = useState(2);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('polyx-bridge-theme', theme);
  }, [theme]);

  const push = useCallback((level: LogLevel, message: string) => {
    setActivity((prev) => [{ id: nowId(), level, message, at: Date.now() }, ...prev].slice(0, 50));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, poly, eth, ev, tr] = await Promise.all([
        api.status(),
        api.polyAccounts(),
        api.ethAccounts(),
        api.events().catch(() => ({ events: [] as BridgeEvent[], fromBlock: 0, toBlock: 0 })),
        api.transfers(40),
      ]);
      setStatus(s);
      setPolyAccounts(poly.accounts);
      setEthAccounts(eth.accounts);
      setEvents(ev.events);
      setTransfers(tr.transfers);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const selectedPoly = useMemo(
    () => polyAccounts.find((a) => a.mnemonic === polySender) ?? polyAccounts[1],
    [polyAccounts, polySender],
  );
  const selectedEth = ethAccounts[ethAccountIdx] ?? ethAccounts[0];

  const ethCfg = status
    ? {
        rpcUrl: status.eth.rpcUrl,
        chainId: status.eth.chainId,
        bridgeAddress: status.eth.bridgeAddress,
        wPolyxAddress: status.eth.wPolyxAddress,
      }
    : null;

  const canSubmit = useMemo(() => {
    if (busy || !status) return false;
    if (!amount || Number(amount) <= 0) return false;
    if (direction === 'poly_to_eth') {
      return Boolean(selectedPoly && selectedEth && status.relayer.ok && status.polymesh.ok);
    }
    return Boolean(selectedEth && selectedPoly && status.eth.ok && ethCfg);
  }, [busy, status, amount, direction, selectedPoly, selectedEth, ethCfg]);

  async function onBridge() {
    if (!canSubmit || !selectedPoly || !selectedEth || !ethCfg) return;
    setBusy(true);
    try {
      if (direction === 'poly_to_eth') {
        push(
          'wait',
          `Locking ${amount} POLYX from ${selectedPoly.name} → mint to ${shortAddr(selectedEth.address)}…`,
        );
        const result = await api.lock({
          senderMnemonic: selectedPoly.mnemonic,
          ethRecipient: selectedEth.address,
          amount,
        });
        setTrackedIntentId(result.intentId);
        push(
          'ok',
          `Locked intent ${result.intentId.slice(0, 8)}… memo ${result.memo}. Waiting for status → completed.`,
        );
      } else {
        push(
          'wait',
          `Burning ${amount} wPOLYX from ${selectedEth.name} → release to ${selectedPoly.name}…`,
        );
        const signer = signerFromPrivateKey(
          selectedEth.privateKey,
          ethCfg.rpcUrl,
          ethCfg.chainId,
        );
        const hash = await bridgeToPolymesh(signer, ethCfg, selectedPoly.address, amount);
        push('ok', `Burned. Tx ${shortAddr(hash, 6)}. Relayer will release POLYX.`);
      }
      await refresh();
    } catch (err) {
      push('err', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const goBridge = () => setTab('bridge');

  return (
    <div className="app">
      <div className="app-bg" aria-hidden />

      <header className="topnav">
        <div className="topnav-left">
          <button type="button" className="brand" onClick={() => setTab('home')}>
            <span className="brand-mark">
              <MarkIcon />
            </span>
            <span className="brand-text">
              <strong>POLYX Bridge</strong>
              <span>Polymesh × Ethereum</span>
            </span>
          </button>
        </div>

        <nav className="nav-tabs" aria-label="Primary">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`nav-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="topnav-right">
          <button
            type="button"
            className="icon-btn"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label="Toggle theme"
            onClick={() => setTheme((th) => (th === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" className="btn btn-primary nav-cta" onClick={goBridge}>
            Launch App
          </button>
        </div>
      </header>

      <main className="main">
        {loadError && (
          <div className="alert err">
            <AlertIcon />
            <div>
              API unreachable: {loadError}. Run <code>cd bridge/web && yarn dev</code>
            </div>
          </div>
        )}

        {!status?.relayer.ok && status && tab !== 'home' && (
          <div className="alert warn">
            <AlertIcon />
            <div>
              Relayer offline — transfers won&apos;t complete.{' '}
              <code>cd bridge/relayer && yarn start</code>
            </div>
          </div>
        )}

        <div className="page-enter" key={tab}>
          {tab === 'home' && (
            <HomePage
              status={status}
              onLaunch={goBridge}
              onDocs={() => setTab('docs')}
              onNetwork={() => setTab('network')}
            />
          )}
          {tab === 'bridge' && (
            <BridgePage
              status={status}
              polyAccounts={polyAccounts}
              ethAccounts={ethAccounts}
              events={events}
              activity={activity}
              transfers={transfers}
              trackedIntentId={trackedIntentId}
              direction={direction}
              setDirection={setDirection}
              amount={amount}
              setAmount={setAmount}
              polySender={polySender}
              setPolySender={setPolySender}
              ethAccountIdx={ethAccountIdx}
              setEthAccountIdx={setEthAccountIdx}
              selectedPoly={selectedPoly}
              selectedEth={selectedEth}
              busy={busy}
              canSubmit={canSubmit}
              onBridge={() => void onBridge()}
              onRefresh={() => void refresh()}
            />
          )}
          {tab === 'portfolio' && (
            <PortfolioPage status={status} polyAccounts={polyAccounts} ethAccounts={ethAccounts} />
          )}
          {tab === 'activity' && (
            <ActivityPage activity={activity} events={events} transfers={transfers} />
          )}
          {tab === 'network' && <NetworkPage status={status} onRefresh={() => void refresh()} />}
          {tab === 'docs' && <DocsPage onLaunch={goBridge} />}
        </div>
      </main>

      <footer className="site-footer">
        <div className="site-footer-inner">
          <span>
            Bridge <code>{shortAddr(status?.eth.bridgeAddress ?? '', 5)}</code>
            {' · '}
            wPOLYX <code>{shortAddr(status?.eth.wPolyxAddress ?? '', 5)}</code>
          </span>
          <span>Local demo · single trusted relayer · not audited</span>
        </div>
      </footer>
    </div>
  );
}

/* ─── Pages ────────────────────────────────────────────────────────────── */

function HomePage(props: {
  status: StatusResponse | null;
  onLaunch: () => void;
  onDocs: () => void;
  onNetwork: () => void;
}) {
  const { status, onLaunch, onDocs, onNetwork } = props;
  const allOk = Boolean(status?.eth.ok && status?.polymesh.ok && status?.relayer.ok);

  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-badge">
          <span className="live-dot" />
          {allOk ? 'Testnet live' : 'Connecting…'}
        </div>
        <h1>Bridge POLYX across chains — simply and securely.</h1>
        <p className="hero-sub">
          Move native POLYX on Polymesh to wrapped wPOLYX on Ethereum, and back again.
          Lock-and-mint model. 1:1. Built for local development.
        </p>
        <div className="hero-cta">
          <button type="button" className="btn btn-primary btn-lg" onClick={onLaunch}>
            Launch Bridge
          </button>
          <button type="button" className="btn btn-secondary btn-lg" onClick={onDocs}>
            How it works
          </button>
        </div>

        <div className="hero-stats">
          <div className="hero-stat">
            <div className="label">Escrow</div>
            <div className="value mono">
              {status ? formatPolyx(status.polymesh.escrowBalance) : '—'}
            </div>
            <div className="hint">POLYX locked</div>
          </div>
          <div className="hero-stat">
            <div className="label">Supply</div>
            <div className="value mono">
              {status?.eth.wPolyxSupply ? formatPolyx(status.eth.wPolyxSupply) : '—'}
            </div>
            <div className="hint">wPOLYX minted</div>
          </div>
          <div className="hero-stat">
            <div className="label">Network</div>
            <div className="value">{status?.eth.ok ? 'Anvil' : '…'}</div>
            <div className="hint">chain {status?.eth.chainId ?? '—'}</div>
          </div>
          <div className="hero-stat">
            <div className="label">Relayer</div>
            <div className="value">{status?.relayer.ok ? 'Online' : 'Offline'}</div>
            <div className="hint">
              <button type="button" className="btn btn-ghost" onClick={onNetwork}>
                View status
              </button>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <div className="eyebrow">Why this bridge</div>
          <h2>Built for transparent cross-chain value</h2>
          <p>Familiar crypto product UX, wired to your local Polymesh + Anvil stack.</p>
        </div>
        <div className="feature-grid">
          <article className="feature-card">
            <div className="feature-icon">
              <IconLayers />
            </div>
            <h3>1:1 lock &amp; mint</h3>
            <p>
              POLYX is escrowed on Polymesh; wPOLYX is minted on Ethereum. No rebased decimals —
              both sides use 6 digits.
            </p>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <IconBolt />
            </div>
            <h3>Two-way by design</h3>
            <p>
              Burn wPOLYX to release native POLYX from escrow. Relayer watches both chains and
              settles after finality.
            </p>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <IconShield />
            </div>
            <h3>Dev-first trust model</h3>
            <p>
              Single trusted relayer for the MVP — clear, inspectable, and perfect for demos and
              integration work. Not production custody.
            </p>
          </article>
        </div>
      </section>

      <section>
        <div className="section-head">
          <div className="eyebrow">Get started</div>
          <h2>Three steps to your first transfer</h2>
        </div>
        <div className="steps">
          <div className="step">
            <h3>Pick a direction</h3>
            <p>Polymesh → Ethereum locks POLYX. Ethereum → Polymesh burns wPOLYX.</p>
          </div>
          <div className="step">
            <h3>Choose accounts</h3>
            <p>Use local Polymesh dev keys and Anvil accounts — no wallet install required.</p>
          </div>
          <div className="step">
            <h3>Confirm &amp; track</h3>
            <p>Watch balances update and follow activity as the relayer finalizes the move.</p>
          </div>
        </div>
      </section>

      <section className="cta-banner">
        <h2>Ready to move POLYX?</h2>
        <p>Open the bridge, select accounts, and transfer in either direction.</p>
        <button type="button" className="btn btn-primary btn-lg" onClick={onLaunch}>
          Open Bridge
        </button>
      </section>
    </div>
  );
}

function BridgePage(props: {
  status: StatusResponse | null;
  polyAccounts: PolyAccount[];
  ethAccounts: EthAccount[];
  events: BridgeEvent[];
  activity: Activity[];
  transfers: TransferRecord[];
  trackedIntentId: string | null;
  direction: Direction;
  setDirection: (d: Direction) => void;
  amount: string;
  setAmount: (v: string) => void;
  polySender: string;
  setPolySender: (v: string) => void;
  ethAccountIdx: number;
  setEthAccountIdx: (n: number) => void;
  selectedPoly?: PolyAccount;
  selectedEth?: EthAccount;
  busy: boolean;
  canSubmit: boolean;
  onBridge: () => void;
  onRefresh: () => void;
}) {
  const {
    status,
    polyAccounts,
    ethAccounts,
    events,
    activity,
    transfers,
    trackedIntentId,
    direction,
    setDirection,
    amount,
    setAmount,
    polySender,
    setPolySender,
    ethAccountIdx,
    setEthAccountIdx,
    selectedPoly,
    selectedEth,
    busy,
    canSubmit,
    onBridge,
    onRefresh,
  } = props;

  const tracked = trackedIntentId
    ? transfers.find((t) => t.intentId === trackedIntentId)
    : transfers[0];

  const polyOptions = polyAccounts
    .filter((a) => !a.isEscrow)
    .map((a) => ({
      value: a.mnemonic,
      title: a.name,
      subtitle: `${formatPolyx(a.balance)} POLYX`,
    }));

  const ethOptions = ethAccounts.map((a, i) => ({
    value: String(i),
    title: a.name.replace('Anvil ', 'Account '),
    subtitle: `${formatPolyx(a.wPolyxBalance)} wPOLYX`,
  }));

  const fromBalance =
    direction === 'poly_to_eth'
      ? selectedPoly
        ? `${formatPolyx(selectedPoly.balance)} POLYX available`
        : '—'
      : selectedEth
        ? `${formatPolyx(selectedEth.wPolyxBalance)} wPOLYX available`
        : '—';

  const toBalance =
    direction === 'poly_to_eth'
      ? selectedEth
        ? `${formatPolyx(selectedEth.wPolyxBalance)} wPOLYX · ${shortAddr(selectedEth.address, 4)}`
        : '—'
      : selectedPoly
        ? `${formatPolyx(selectedPoly.balance)} POLYX · ${shortAddr(selectedPoly.address, 4)}`
        : '—';

  return (
    <>
      <h2 className="page-title">Bridge</h2>
      <p className="page-sub">Transfer value between Polymesh and local Ethereum (Anvil).</p>

      <div className="layout-2">
        <section className="card">
          <div className="card-header">
            <h3>Transfer</h3>
            <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={busy}>
              Refresh
            </button>
          </div>
          <div className="card-body">
            <div className="segmented" role="tablist" aria-label="Direction">
              <button
                type="button"
                className={direction === 'poly_to_eth' ? 'active' : ''}
                onClick={() => setDirection('poly_to_eth')}
              >
                To Ethereum
              </button>
              <button
                type="button"
                className={direction === 'eth_to_poly' ? 'active' : ''}
                onClick={() => setDirection('eth_to_poly')}
              >
                To Polymesh
              </button>
            </div>

            <div className="field">
              <div className="field-label">
                <span>From</span>
                <span className="hint">Sender</span>
              </div>
              <div className="token-box">
                <div className="token-box-top">
                  <div className="chain-pill">
                    <span className={`glyph ${direction === 'poly_to_eth' ? 'poly' : 'eth'}`}>
                      {direction === 'poly_to_eth' ? 'P' : 'E'}
                    </span>
                    {direction === 'poly_to_eth' ? 'Polymesh' : 'Ethereum'}
                  </div>
                  <div className="select-wrap">
                    <select
                      value={direction === 'poly_to_eth' ? polySender : String(ethAccountIdx)}
                      onChange={(e) => {
                        if (direction === 'poly_to_eth') setPolySender(e.target.value);
                        else setEthAccountIdx(Number(e.target.value));
                      }}
                    >
                      {(direction === 'poly_to_eth' ? polyOptions : ethOptions).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.title} · {o.subtitle}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="amount-input-row">
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                  />
                  <span className="amount-unit">
                    {direction === 'poly_to_eth' ? 'POLYX' : 'wPOLYX'}
                  </span>
                </div>
                <div className="balance-line">{fromBalance}</div>
              </div>
            </div>

            <div className="swap-center">
              <button
                type="button"
                className="swap-btn"
                onClick={() =>
                  setDirection(direction === 'poly_to_eth' ? 'eth_to_poly' : 'poly_to_eth')
                }
                aria-label="Flip direction"
              >
                <SwapIcon />
              </button>
            </div>

            <div className="field">
              <div className="field-label">
                <span>To</span>
                <span className="hint">Recipient</span>
              </div>
              <div className="token-box">
                <div className="token-box-top">
                  <div className="chain-pill">
                    <span className={`glyph ${direction === 'poly_to_eth' ? 'eth' : 'poly'}`}>
                      {direction === 'poly_to_eth' ? 'E' : 'P'}
                    </span>
                    {direction === 'poly_to_eth' ? 'Ethereum' : 'Polymesh'}
                  </div>
                  <div className="select-wrap">
                    <select
                      value={direction === 'poly_to_eth' ? String(ethAccountIdx) : polySender}
                      onChange={(e) => {
                        if (direction === 'poly_to_eth') setEthAccountIdx(Number(e.target.value));
                        else setPolySender(e.target.value);
                      }}
                    >
                      {(direction === 'poly_to_eth' ? ethOptions : polyOptions).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.title} · {o.subtitle}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="balance-line">{toBalance}</div>
              </div>
            </div>

            <div className="quick-row">
              {['1', '10', '50', '100'].map((q) => (
                <button key={q} type="button" className="pill-btn" onClick={() => setAmount(q)}>
                  {q}
                </button>
              ))}
            </div>

            <div className="summary-card">
              {direction === 'poly_to_eth' ? (
                <>
                  Lock <strong>{amount || '—'}</strong> POLYX from{' '}
                  <strong>{selectedPoly?.name ?? '…'}</strong>. Relayer mints wPOLYX to{' '}
                  <strong>{selectedEth?.name?.replace('Anvil ', 'Account ') ?? '…'}</strong>.
                </>
              ) : (
                <>
                  Burn <strong>{amount || '—'}</strong> wPOLYX from{' '}
                  <strong>{selectedEth?.name?.replace('Anvil ', 'Account ') ?? '…'}</strong>.
                  Relayer releases POLYX to <strong>{selectedPoly?.name ?? '…'}</strong>.
                </>
              )}
            </div>

            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              style={{ marginTop: 18 }}
              disabled={!canSubmit}
              onClick={onBridge}
            >
              {busy
                ? 'Working…'
                : direction === 'poly_to_eth'
                  ? 'Bridge to Ethereum'
                  : 'Bridge to Polymesh'}
            </button>
          </div>
        </section>

        <aside className="layout-stack">
          <section className="card">
            <div className="card-header">
              <h3>Snapshot</h3>
            </div>
            <div className="card-body">
              <div className="stat-grid">
                <Stat
                  label="Escrow"
                  value={status ? formatPolyx(status.polymesh.escrowBalance) : '—'}
                  hint="POLYX"
                />
                <Stat
                  label="Supply"
                  value={status?.eth.wPolyxSupply ? formatPolyx(status.eth.wPolyxSupply) : '—'}
                  hint="wPOLYX"
                />
                <Stat
                  label="Nonce"
                  value={status?.eth.nonce ?? '—'}
                  hint={status?.eth.paused ? 'Paused' : 'Active'}
                />
                <Stat label="Block" value={status ? String(status.eth.block) : '—'} hint="Anvil" />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h3>Transfer status</h3>
            </div>
            <div className="card-body">
              {tracked ? (
                <TransferStatusCard transfer={tracked} />
              ) : (
                <div className="feed-empty">Submit a transfer to track its state machine.</div>
              )}
              <div className="list-title" style={{ marginTop: 14 }}>
                Recent transfers
              </div>
              <Feed
                empty="No transfers in relayer DB yet."
                items={transfers.slice(0, 8).map((t) => ({
                  key: t.intentId,
                  level: statusToLevel(t.status),
                  time: t.status,
                  body: (
                    <>
                      <strong>{t.direction === 'poly_to_eth' ? 'P→E' : 'E→P'}</strong>{' '}
                      {formatPolyx(t.amount)} · {t.intentId.slice(0, 10)}…
                      {t.error ? <div className="row-meta">{t.error}</div> : null}
                    </>
                  ),
                }))}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h3>Session log</h3>
            </div>
            <div className="card-body">
              <Feed
                empty="Actions you take will show here."
                items={activity.slice(0, 6).map((a) => ({
                  key: a.id,
                  level: a.level,
                  time: new Date(a.at).toLocaleTimeString(undefined, { hour12: false }),
                  body: a.message,
                }))}
              />
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h3>On-chain events</h3>
            </div>
            <div className="card-body">
              <Feed
                empty="No bridge events on Anvil yet."
                items={events.slice(0, 6).map((e) => ({
                  key: `${e.type}-${e.id}-${e.txHash}`,
                  time: `#${e.blockNumber}`,
                  body:
                    e.type === 'MintedFromPolymesh' ? (
                      <>
                        Minted <strong>{formatPolyx(e.amount)}</strong> → {shortAddr(e.recipient)}
                      </>
                    ) : (
                      <>
                        Burned <strong>{formatPolyx(e.amount)}</strong> →{' '}
                        {shortAddr(e.polymeshRecipient, 4)}
                      </>
                    ),
                }))}
              />
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function PortfolioPage(props: {
  status: StatusResponse | null;
  polyAccounts: PolyAccount[];
  ethAccounts: EthAccount[];
}) {
  const { status, polyAccounts, ethAccounts } = props;
  const totalPoly = polyAccounts.reduce((s, a) => s + BigInt(a.balance || '0'), 0n);
  const totalW = ethAccounts.reduce((s, a) => s + BigInt(a.wPolyxBalance || '0'), 0n);

  return (
    <>
      <h2 className="page-title">Portfolio</h2>
      <p className="page-sub">Balances across Polymesh dev accounts and Anvil wallets.</p>

      <div className="stat-grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Total POLYX" value={formatPolyx(totalPoly.toString())} hint="all accounts" />
        <Stat label="Total wPOLYX" value={formatPolyx(totalW.toString())} hint="Anvil wallets" />
        <Stat
          label="Escrow"
          value={status ? formatPolyx(status.polymesh.escrowBalance) : '—'}
          hint="bridge reserve"
        />
        <Stat
          label="Minted supply"
          value={status?.eth.wPolyxSupply ? formatPolyx(status.eth.wPolyxSupply) : '—'}
          hint="on Ethereum"
        />
      </div>

      <div className="layout-2">
        <section className="card">
          <div className="card-header">
            <h3>Polymesh accounts</h3>
          </div>
          <div className="card-body">
            {polyAccounts.map((a) => (
              <div key={a.address} className="row">
                <div className="row-left">
                  <span className={`avatar${a.isEscrow ? ' escrow' : ''}`}>{a.name.slice(0, 1)}</span>
                  <div>
                    <div>
                      {a.name}
                      {a.isEscrow ? ' · Escrow' : ''}
                    </div>
                    <div className="row-meta mono">{shortAddr(a.address, 6)}</div>
                  </div>
                </div>
                <span className="row-right mono">{formatPolyx(a.balance)} POLYX</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h3>Ethereum (Anvil)</h3>
          </div>
          <div className="card-body">
            {ethAccounts.map((a) => (
              <div key={a.address} className="row">
                <div className="row-left">
                  <span className="avatar eth">{a.name.replace(/\D/g, '') || '0'}</span>
                  <div>
                    <div>{a.name.replace('Anvil ', 'Account ')}</div>
                    <div className="row-meta mono">{shortAddr(a.address, 6)}</div>
                  </div>
                </div>
                <span className="row-right mono">{formatPolyx(a.wPolyxBalance)} wPOLYX</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function ActivityPage(props: {
  activity: Activity[];
  events: BridgeEvent[];
  transfers: TransferRecord[];
}) {
  const { activity, events, transfers } = props;
  return (
    <>
      <h2 className="page-title">Activity</h2>
      <p className="page-sub">Transfer state machine, session log, and on-chain events.</p>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>Transfers (status machine)</h3>
        </div>
        <div className="card-body">
          <Feed
            tall
            empty="No transfers yet. Bridge a payment to populate SQLite statuses."
            items={transfers.map((t) => ({
              key: t.intentId,
              level: statusToLevel(t.status),
              time: t.status,
              body: (
                <>
                  <strong>{t.direction === 'poly_to_eth' ? 'Polymesh → Eth' : 'Eth → Polymesh'}</strong>
                  {' · '}
                  {formatPolyx(t.amount)}
                  <div className="row-meta mono">
                    {t.intentId}
                    {t.relayedTxHash ? ` · relay ${shortAddr(t.relayedTxHash, 6)}` : ''}
                  </div>
                  {t.error ? <div className="row-meta">{t.error}</div> : null}
                </>
              ),
            }))}
          />
        </div>
      </section>

      <div className="layout-2">
        <section className="card">
          <div className="card-header">
            <h3>Session log</h3>
          </div>
          <div className="card-body">
            <Feed
              tall
              empty="No actions yet — open Bridge and make a transfer."
              items={activity.map((a) => ({
                key: a.id,
                level: a.level,
                time: new Date(a.at).toLocaleTimeString(undefined, { hour12: false }),
                body: a.message,
              }))}
            />
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h3>On-chain</h3>
          </div>
          <div className="card-body">
            <Feed
              tall
              empty="No BridgedToPolymesh / MintedFromPolymesh events yet."
              items={events.map((e) => ({
                key: `${e.type}-${e.id}-${e.txHash}`,
                time: `#${e.blockNumber}`,
                body:
                  e.type === 'MintedFromPolymesh' ? (
                    <>
                      <strong>Mint</strong> {formatPolyx(e.amount)} wPOLYX → {shortAddr(e.recipient)}
                      <div className="row-meta mono">{shortAddr(e.txHash, 8)}</div>
                    </>
                  ) : (
                    <>
                      <strong>Burn</strong> {formatPolyx(e.amount)} wPOLYX →{' '}
                      {shortAddr(e.polymeshRecipient, 4)}
                      <div className="row-meta mono">{shortAddr(e.txHash, 8)}</div>
                    </>
                  ),
              }))}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function NetworkPage(props: { status: StatusResponse | null; onRefresh: () => void }) {
  const s = props.status;
  return (
    <>
      <h2 className="page-title">Network</h2>
      <p className="page-sub">Live health of Polymesh, Anvil, contracts, and the relayer.</p>

      <div style={{ marginBottom: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={props.onRefresh}>
          Refresh status
        </button>
      </div>

      <div className="info-grid">
        <div className="info-tile">
          <div className="k">Polymesh</div>
          <div className={`status-dot-row ${s?.polymesh.ok ? 'ok' : 'bad'}`}>
            <span className="dot" />
            {s?.polymesh.ok ? 'Connected' : 'Down'}
          </div>
          <div className="v mono" style={{ marginTop: 10 }}>
            {s?.polymesh.nodeUrl ?? '—'}
          </div>
          <div className="row-meta" style={{ marginTop: 6 }}>
            Escrow {s?.polymesh.escrow ? shortAddr(s.polymesh.escrow, 8) : '—'} ·{' '}
            {s ? formatPolyx(s.polymesh.escrowBalance) : '—'} POLYX
          </div>
        </div>

        <div className="info-tile">
          <div className="k">Ethereum (Anvil)</div>
          <div className={`status-dot-row ${s?.eth.ok ? 'ok' : 'bad'}`}>
            <span className="dot" />
            {s?.eth.ok ? `Block ${s.eth.block}` : 'Down'}
          </div>
          <div className="v mono" style={{ marginTop: 10 }}>
            {s?.eth.rpcUrl ?? '—'}
          </div>
          <div className="row-meta" style={{ marginTop: 6 }}>
            Chain ID {s?.eth.chainId ?? '—'}
          </div>
        </div>

        <div className="info-tile">
          <div className="k">Relayer</div>
          <div className={`status-dot-row ${s?.relayer.ok ? 'ok' : 'bad'}`}>
            <span className="dot" />
            {s?.relayer.ok ? 'Intent API up' : 'Offline'}
          </div>
          <div className="v mono" style={{ marginTop: 10 }}>
            {s?.relayer.url ?? '—'}
          </div>
          <div className="row-meta" style={{ marginTop: 6 }}>
            {s?.relayer.detail ?? ''}
          </div>
        </div>

        <div className="info-tile">
          <div className="k">Contracts</div>
          <div className="v" style={{ marginTop: 8 }}>
            Bridge
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {s?.eth.bridgeAddress ?? '—'}
          </div>
          <div className="v" style={{ marginTop: 10 }}>
            wPOLYX
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {s?.eth.wPolyxAddress ?? '—'}
          </div>
          <div className="row-meta" style={{ marginTop: 8 }}>
            Relayer role {s?.eth.relayer ? shortAddr(s.eth.relayer, 6) : '—'} · nonce{' '}
            {s?.eth.nonce ?? '—'} · {s?.eth.paused ? 'PAUSED' : 'active'}
          </div>
        </div>
      </div>
    </>
  );
}

function DocsPage(props: { onLaunch: () => void }) {
  return (
    <>
      <h2 className="page-title">Docs</h2>
      <p className="page-sub">How the local POLYX ↔ wPOLYX bridge works.</p>

      <section className="card">
        <div className="card-body">
          <div className="docs-block">
            <h4>Model</h4>
            <p>
              Escrow / lock-mint. Users never mint native POLYX. Bridging Polymesh → Ethereum locks
              POLYX in an escrow account; the relayer mints the same amount of wPOLYX (6 decimals).
              Bridging back burns wPOLYX and releases POLYX from escrow.
            </p>
          </div>
          <div className="docs-block">
            <h4>Polymesh → Ethereum (intent id)</h4>
            <ul>
              <li>
                <code>POST /lock-intent</code> → <code>intentId</code> + memo <code>b:&lt;id&gt;</code>
              </li>
              <li>POLYX transfer to escrow carries that memo (32-byte safe).</li>
              <li>Relayer parses memo, validates amount/sender, mints wPOLYX.</li>
              <li>Status: intent_registered → locked → relaying → completed.</li>
            </ul>
          </div>
          <div className="docs-block">
            <h4>Ethereum → Polymesh</h4>
            <ul>
              <li>UI approves the bridge and calls <code>bridgeToPolymesh</code>.</li>
              <li>Contract burns wPOLYX and emits <code>BridgedToPolymesh</code>.</li>
              <li>Relayer releases POLYX from escrow to the SS58 recipient.</li>
            </ul>
          </div>
          <div className="docs-block">
            <h4>E2E</h4>
            <p>
              Run <code>./bridge/scripts/e2e-bridge.sh</code> (add <code>--restart</code> to kill
              and restart the relayer after lock).
            </p>
          </div>
          <div className="docs-block">
            <h4>Threat model (summary)</h4>
            <p>
              Single trusted relayer holds mint + escrow keys. Replay is guarded on-chain and in
              SQLite. Intent API is local/unauthenticated — do not expose publicly. Full write-up
              lives in <code>bridge/README.md</code>.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={props.onLaunch}>
            Open Bridge
          </button>
        </div>
      </section>
    </>
  );
}

function statusToLevel(status: TransferStatus): LogLevel {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'relaying' || status === 'awaiting_finality' || status === 'locked') return 'wait';
  return 'info';
}

function TransferStatusCard(props: { transfer: TransferRecord }) {
  const t = props.transfer;
  const steps =
    t.direction === 'poly_to_eth'
      ? (['intent_registered', 'locked', 'relaying', 'completed'] as TransferStatus[])
      : (['awaiting_finality', 'relaying', 'completed'] as TransferStatus[]);

  const idx = steps.indexOf(t.status === 'failed' ? 'relaying' : t.status);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="row-left">
          <span className="avatar">{t.direction === 'poly_to_eth' ? 'P' : 'E'}</span>
          <div>
            <div>{t.direction === 'poly_to_eth' ? 'Polymesh → Ethereum' : 'Ethereum → Polymesh'}</div>
            <div className="row-meta mono">{t.intentId}</div>
          </div>
        </div>
        <span className={`row-right ${t.status === 'failed' ? '' : ''}`}>{t.status}</span>
      </div>
      <div className="quick-row" style={{ marginTop: 0 }}>
        {steps.map((s, i) => (
          <span
            key={s}
            className="pill-btn"
            style={{
              cursor: 'default',
              opacity: t.status === 'failed' ? (i <= Math.max(idx, 0) ? 1 : 0.4) : i <= idx ? 1 : 0.35,
              borderColor:
                t.status === 'failed' && s === 'relaying'
                  ? 'var(--red)'
                  : i <= idx
                    ? 'rgba(96, 165, 250, 0.55)'
                    : undefined,
              background: i <= idx ? 'var(--blue-soft)' : 'transparent',
            }}
          >
            {s}
          </span>
        ))}
      </div>
      <div className="balance-line" style={{ marginTop: 10 }}>
        Amount {formatPolyx(t.amount)}
        {t.relayedTxHash ? ` · relayed ${shortAddr(t.relayedTxHash, 6)}` : ''}
        {t.error ? ` · ${t.error}` : ''}
      </div>
    </div>
  );
}

/* ─── Small components ─────────────────────────────────────────────────── */

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value mono">{props.value}</div>
      {props.hint ? <div className="stat-hint">{props.hint}</div> : null}
    </div>
  );
}

function Feed(props: {
  empty: string;
  tall?: boolean;
  items: Array<{
    key: string;
    time: string;
    body: ReactNode;
    level?: LogLevel;
  }>;
}) {
  return (
    <div className={`feed${props.tall ? ' tall' : ''}`}>
      {props.items.length === 0 && <div className="feed-empty">{props.empty}</div>}
      {props.items.map((item) => (
        <div key={item.key} className={`feed-item ${item.level ?? ''}`}>
          <span className="time">{item.time}</span>
          <span>{item.body}</span>
        </div>
      ))}
    </div>
  );
}
