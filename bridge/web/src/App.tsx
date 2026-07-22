import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  api,
  type BridgeEvent,
  type EthAccount,
  type PolyAccount,
  type StatusResponse,
} from './lib/api';
import {
  bridgeToPolymesh,
  formatPolyx,
  shortAddr,
  signerFromPrivateKey,
} from './lib/eth';

type Direction = 'poly_to_eth' | 'eth_to_poly';
type LogLevel = 'info' | 'ok' | 'err' | 'wait';

type Activity = {
  id: string;
  level: LogLevel;
  message: string;
  at: number;
};

function nowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [polyAccounts, setPolyAccounts] = useState<PolyAccount[]>([]);
  const [ethAccounts, setEthAccounts] = useState<EthAccount[]>([]);
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [direction, setDirection] = useState<Direction>('poly_to_eth');
  const [amount, setAmount] = useState('10');
  const [polySender, setPolySender] = useState('//Bob');
  const [ethAccountIdx, setEthAccountIdx] = useState(2);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const push = useCallback((level: LogLevel, message: string) => {
    setActivity((prev) => [{ id: nowId(), level, message, at: Date.now() }, ...prev].slice(0, 40));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, poly, eth, ev] = await Promise.all([
        api.status(),
        api.polyAccounts(),
        api.ethAccounts(),
        api.events().catch(() => ({ events: [] as BridgeEvent[], fromBlock: 0, toBlock: 0 })),
      ]);
      setStatus(s);
      setPolyAccounts(poly.accounts);
      setEthAccounts(eth.accounts);
      setEvents(ev.events);
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
        push(
          'ok',
          `Locked. ${result.txHash ? `Tx ${shortAddr(result.txHash, 6)}. ` : ''}Mint after finality.`,
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

  function swapDirection() {
    setDirection((d) => (d === 'poly_to_eth' ? 'eth_to_poly' : 'poly_to_eth'));
  }

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

  const statusChips = [
    {
      label: 'Polymesh',
      ok: status?.polymesh.ok,
      detail: status?.polymesh.ok ? 'Online' : (status?.polymesh.error ?? '…'),
    },
    {
      label: 'Anvil',
      ok: status?.eth.ok,
      detail: status?.eth.ok ? `Block ${status.eth.block}` : (status?.eth.error ?? '…'),
    },
    {
      label: 'Relayer',
      ok: status?.relayer.ok,
      detail: status?.relayer.ok ? 'Ready' : 'Offline',
    },
  ];

  return (
    <div className="app">
      <header className="nav">
        <div className="nav-brand">
          <div className="nav-mark">
            <MarkIcon />
          </div>
          <div className="nav-titles">
            <h1>Bridge</h1>
            <p>POLYX · wPOLYX</p>
          </div>
        </div>
        <div className="status-cluster">
          {statusChips.map((p) => (
            <div
              key={p.label}
              className={`status-chip ${p.ok ? 'ok' : p.ok === false ? 'bad' : ''}`}
            >
              <span className="dot" />
              <span className="name">{p.label}</span>
              <span className="meta">{p.detail}</span>
            </div>
          ))}
        </div>
      </header>

      <div className="shell">
        <div className="hero">
          <div className="hero-kicker">Local development</div>
          <h2>Move value between chains.</h2>
          <p>A clean interface for the Polymesh ↔ Ethereum lock-and-mint bridge.</p>
        </div>

        {loadError && (
          <div className="alert err">
            <AlertIcon />
            <div>
              API unreachable: {loadError}. Run <code>cd bridge/web && yarn dev</code>
            </div>
          </div>
        )}

        {!status?.relayer.ok && status && (
          <div className="alert warn">
            <AlertIcon />
            <div>
              Relayer is offline — transfers won&apos;t complete. Start it with{' '}
              <code>cd bridge/relayer && yarn start</code>
            </div>
          </div>
        )}

        <main className="layout">
          <section className="card bridge-panel">
            <div className="card-header">
              <h3>Transfer</h3>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void refresh()}
                disabled={busy}
              >
                Refresh
              </button>
            </div>
            <div className="card-body">
              <div className="segmented" role="tablist" aria-label="Bridge direction">
                <button
                  type="button"
                  role="tab"
                  aria-selected={direction === 'poly_to_eth'}
                  className={direction === 'poly_to_eth' ? 'active' : ''}
                  onClick={() => setDirection('poly_to_eth')}
                >
                  To Ethereum
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={direction === 'eth_to_poly'}
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
                        aria-label="Source account"
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
                      inputMode="decimal"
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
                  onClick={swapDirection}
                  title="Flip direction"
                  aria-label="Flip bridge direction"
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
                        aria-label="Destination account"
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
                className={`cta${busy ? ' busy' : ''}`}
                disabled={!canSubmit}
                onClick={() => void onBridge()}
              >
                {busy
                  ? 'Working…'
                  : direction === 'poly_to_eth'
                    ? 'Bridge to Ethereum'
                    : 'Bridge to Polymesh'}
              </button>
            </div>
          </section>

          <aside className="side">
            <section className="card">
              <div className="card-header">
                <h3>Overview</h3>
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
                  <Stat
                    label="Block"
                    value={status ? String(status.eth.block) : '—'}
                    hint="Anvil"
                  />
                </div>

                <div className="list-section">
                  <div className="list-title">Polymesh</div>
                  {polyAccounts.map((a) => (
                    <div key={a.address} className="row">
                      <div className="row-left">
                        <span className={`avatar${a.isEscrow ? ' escrow' : ''}`}>
                          {a.name.slice(0, 1)}
                        </span>
                        <span>
                          {a.name}
                          {a.isEscrow ? ' · Escrow' : ''}
                        </span>
                      </div>
                      <span className="row-right mono">{formatPolyx(a.balance)}</span>
                    </div>
                  ))}
                </div>

                <div className="list-section">
                  <div className="list-title">Ethereum</div>
                  {ethAccounts.map((a) => (
                    <div key={a.address} className="row">
                      <div className="row-left">
                        <span className="avatar eth">{a.name.replace(/\D/g, '') || '0'}</span>
                        <span>{a.name.replace('Anvil ', 'Account ')}</span>
                      </div>
                      <span className="row-right mono">{formatPolyx(a.wPolyxBalance)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <h3>Activity</h3>
              </div>
              <div className="card-body">
                <div className="feed">
                  {activity.length === 0 && (
                    <div className="feed-empty">Your transfers will appear here.</div>
                  )}
                  {activity.map((a) => (
                    <div key={a.id} className={`feed-item ${a.level}`}>
                      <span className="time">
                        {new Date(a.at).toLocaleTimeString(undefined, { hour12: false })}
                      </span>
                      <span>{a.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <h3>On-chain</h3>
              </div>
              <div className="card-body">
                <div className="feed">
                  {events.length === 0 && (
                    <div className="feed-empty">No bridge events on Anvil yet.</div>
                  )}
                  {events.slice(0, 10).map((e) => (
                    <div key={`${e.type}-${e.id}-${e.txHash}`} className="feed-item">
                      <span className="time">#{e.blockNumber}</span>
                      <span>
                        {e.type === 'MintedFromPolymesh' ? (
                          <>
                            Minted <strong>{formatPolyx(e.amount)}</strong> →{' '}
                            {shortAddr(e.recipient)}
                          </>
                        ) : (
                          <>
                            Burned <strong>{formatPolyx(e.amount)}</strong> →{' '}
                            {shortAddr(e.polymeshRecipient, 4)}
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </aside>
        </main>

        <footer className="footer">
          <span>
            Bridge <code>{shortAddr(status?.eth.bridgeAddress ?? '', 5)}</code>
            {' · '}
            wPOLYX <code>{shortAddr(status?.eth.wPolyxAddress ?? '', 5)}</code>
          </span>
          <span>Local demo · not audited · single relayer</span>
        </footer>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value mono">{props.value}</div>
      {props.hint ? <div className="stat-hint">{props.hint}</div> : null}
    </div>
  );
}
