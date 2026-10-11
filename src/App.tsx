import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, date, DemoUser, money, selectedUserId, setSelectedUserId } from './api';

type View = 'home' | 'opportunities' | 'create' | 'work' | 'wallet' | 'inbox' | 'guardian' | 'admin' | 'settings';
type Me = {
  user: DemoUser & { email: string; restricted_at: string | null };
  wallet: { available: number; locked: number; lifetime_earned: number };
  reliability: { score: number; events: number };
  activeContracts: { count: number };
  guardian?: { guardian_name: string; max_per_contract: number; max_per_rolling_period: number } | null;
};
type Contract = {
  id: string;
  title: string;
  summary: string;
  status: string;
  paper_mode: string;
  page_count: number;
  reward: number;
  delivery_reward: number;
  deadline_at: string;
  requester_id: string;
  requester_name: string;
  writer_name?: string;
  safe_point_name: string;
  campus: string;
};
type Delivery = {
  id: string;
  item_description: string;
  direction: string;
  status: string;
  reward: number;
  requester_id: string;
  recipient_id: string;
  courier_id?: string;
  requester_name: string;
  recipient_name: string;
  courier_name?: string;
  safe_point_name: string;
  safe_point_hours?: string;
  campus: string;
};
type Notice = { id: string; title: string; body: string; kind: string; created_at: string; read_at: string | null };

const viewLabels: Record<View, string> = {
  home: 'Home',
  opportunities: 'Browse',
  create: 'Post request',
  work: 'My work',
  wallet: 'Wallet',
  inbox: 'Updates',
  guardian: 'Guardian',
  admin: 'Operations',
  settings: 'Settings',
};

const statusLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const paperLabel = (value: string) => (value === 'REQUESTER_NOTEBOOK' ? 'Requester notebook' : 'Writer paper');

export default function App() {
  const [profiles, setProfiles] = useState<DemoUser[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>('home');
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [mine, setMine] = useState<Contract[]>([]);
  const [delivery, setDelivery] = useState<Delivery[]>([]);
  const [myDelivery, setMyDelivery] = useState<Delivery[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [ledger, setLedger] = useState<any[]>([]);
  const [admin, setAdmin] = useState<any | null>(null);
  const [guardianControls, setGuardianControls] = useState<any[]>([]);
  const [guardianActivity, setGuardianActivity] = useState<any | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<{ type: 'good' | 'bad'; text: string } | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Active Action Modals
  const [counterOfferTarget, setCounterOfferTarget] = useState<Contract | null>(null);
  const [handoffModal, setHandoffModal] = useState<{ leg: Delivery; step: 'PICKUP' | 'DROPOFF'; code?: string; expiresAt?: string; warning?: string } | null>(null);
  const [confirmHandoffModal, setConfirmHandoffModal] = useState<{ leg: Delivery; step: 'PICKUP' | 'DROPOFF' } | null>(null);
  const [reportModal, setReportModal] = useState<{ deliveryLegId?: string; contractId?: string } | null>(null);

  const load = async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const [profileResult, meResult, marketResult, mineResult, deliveryResult, myDeliveryResult, notificationResult, ledgerResult] = await Promise.all([
        api<{ data: DemoUser[] }>('/api/users'),
        api<{ data: Me }>('/api/me'),
        api<{ data: Contract[] }>('/api/contracts?scope=market'),
        api<{ data: Contract[] }>('/api/contracts?scope=mine'),
        api<{ data: Delivery[] }>('/api/delivery'),
        api<{ data: Delivery[] }>('/api/delivery?scope=mine'),
        api<{ data: Notice[] }>('/api/notifications'),
        api<{ data: any[] }>('/api/wallet/ledger'),
      ]);
      setProfiles(profileResult.data);
      setMe(meResult.data);
      setContracts(marketResult.data);
      setMine(mineResult.data);
      setDelivery(deliveryResult.data);
      setMyDelivery(myDeliveryResult.data);
      setNotices(notificationResult.data);
      setLedger(ledgerResult.data);

      if (meResult.data.user.role === 'MODERATOR') {
        setAdmin((await api<{ data: any }>('/api/admin/overview')).data);
      } else {
        setAdmin(null);
      }

      if (meResult.data.user.role === 'GUARDIAN') {
        const [ctrls, act] = await Promise.all([
          api<{ data: any[] }>('/api/guardian/controls'),
          api<{ data: any }>('/api/guardian/activity'),
        ]);
        setGuardianControls(ctrls.data);
        setGuardianActivity(act.data);
      } else {
        setGuardianControls([]);
        setGuardianActivity(null);
      }

      // Refresh contract detail if currently open
      if (detail?.id) {
        const fresh = await api<{ data: any }>(`/api/contracts/${detail.id}`).catch(() => null);
        if (fresh) setDetail(fresh.data);
      }
    } catch (error) {
      flash((error as Error).message, 'bad');
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const flash = (text: string, type: 'good' | 'bad' = 'good') => {
    setMessage({ text, type });
    window.setTimeout(() => setMessage(null), 4500);
  };

  const navigate = (next: View) => {
    setView(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const switchProfile = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedUserId(event.target.value);
    setDetail(null);
    navigate('home');
    void load();
  };

  const openContract = async (contract: { id: string }) => {
    try {
      setDetail((await api<{ data: any }>(`/api/contracts/${contract.id}`)).data);
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const accept = async (id: string) => {
    try {
      await api(`/api/contracts/${id}/accept`, { method: 'POST' });
      flash('Request accepted. Its terms are now immutable.');
      await load(true);
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const claim = async (id: string) => {
    try {
      await api(`/api/delivery/${id}/claim`, { method: 'POST' });
      flash('Delivery claimed. Generate the code only in person at the safe point.');
      await load(true);
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const nav: View[] = useMemo(() => {
    if (!me) return [];
    if (me.user.role === 'MODERATOR') return ['home', 'admin', 'wallet', 'inbox', 'settings'];
    if (me.user.role === 'GUARDIAN') return ['home', 'guardian', 'inbox', 'settings'];
    return ['home', 'opportunities', 'create', 'work', 'wallet', 'inbox', 'settings'];
  }, [me]);

  const unread = notices.filter((notice) => !notice.read_at).length;

  if (busy && !me) return <div className="splash"><div className="logo-mark">a</div><p>Preparing your private student workspace…</p></div>;
  if (!me) return <div className="splash">Unable to load the local demo. Make sure the API is running.</div>;

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="logo-mark">a</span>
          <span>assingly</span>
        </div>
        <p className="side-caption">Student exchange, with boundaries.</p>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button className={`nav-item ${view === item ? 'selected' : ''}`} key={item} onClick={() => navigate(item)}>
              <span>{navIcon(item)}</span>
              {viewLabels[item]}
              {item === 'inbox' && unread > 0 && <i>{unread}</i>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span>Copying-only marketplace</span>
          <p>No answers. No cash. No home addresses.</p>
        </div>
        <div className="profile-switch">
          <label htmlFor="profile">Local demo profile</label>
          <select id="profile" value={selectedUserId()} onChange={switchProfile}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.display_name} · {profile.role.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </aside>

      {menuOpen && <button aria-label="Close menu" className="backdrop" onClick={() => setMenuOpen(false)} />}

      <main>
        <header className="topbar">
          <button className="menu-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>☰</button>
          <div>
            <span className="eyebrow">
              {me.user.role === 'MODERATOR' ? 'Operations console' : me.user.role === 'GUARDIAN' ? 'Guardian view' : me.user.campus || 'Verified campus'}
            </span>
            <h1>{view === 'home' ? `Good ${greeting()}, ${me.user.display_name.split(' ')[0]}.` : viewLabels[view]}</h1>
          </div>
          <div className="top-actions">
            <button className="bell" onClick={() => navigate('inbox')} aria-label="Open updates">
              ◌{unread > 0 && <b>{unread}</b>}
            </button>
            <button className="avatar" onClick={() => navigate('settings')} aria-label="Open settings">
              {me.user.display_name.slice(0, 1)}
            </button>
          </div>
        </header>

        {message && <div className={`toast ${message.type}`}>{message.type === 'good' ? '✓' : '!'} {message.text}</div>}

        <div className="content">
          {view === 'home' && <Home me={me} mine={mine} delivery={myDelivery} notices={notices} navigate={navigate} openContract={openContract} />}
          {view === 'opportunities' && (
            <Opportunities
              contracts={contracts}
              delivery={delivery}
              onOpen={openContract}
              onAccept={accept}
              onClaim={claim}
              onCounter={(contract) => setCounterOfferTarget(contract)}
              me={me}
            />
          )}
          {view === 'create' && (
            <CreateRequest
              onDone={() => {
                flash('Your request is published and Dime is safely locked in escrow.');
                void load(true);
                navigate('work');
              }}
            />
          )}
          {view === 'work' && (
            <MyWork
              mine={mine}
              delivery={myDelivery}
              me={me}
              onOpen={openContract}
              onCancel={async (id) => {
                try {
                  await api(`/api/contracts/${id}/cancel`, { method: 'POST' });
                  flash('Request cancelled and escrow released in full.');
                  await load(true);
                } catch (error) {
                  flash((error as Error).message, 'bad');
                }
              }}
              onInitiateHandoff={async (leg, step) => {
                try {
                  const res = await api<{ data: { code: string; expiresAt: string; step: 'PICKUP' | 'DROPOFF'; warning: string } }>(
                    `/api/delivery/${leg.id}/handoff/initiate`,
                    { method: 'POST', body: JSON.stringify({ step }) },
                  );
                  setHandoffModal({ leg, step, code: res.data.code, expiresAt: res.data.expiresAt, warning: res.data.warning });
                } catch (error) {
                  flash((error as Error).message, 'bad');
                }
              }}
              onConfirmHandoff={(leg, step) => {
                setConfirmHandoffModal({ leg, step });
              }}
              onReport={(leg) => setReportModal({ deliveryLegId: leg.id })}
            />
          )}
          {view === 'wallet' && <Wallet me={me} ledger={ledger} />}
          {view === 'inbox' && (
            <Inbox
              notices={notices}
              onRead={async (id) => {
                await api(`/api/notifications/${id}/read`, { method: 'POST' });
                void load(true);
              }}
              onReadAll={async () => {
                await api('/api/notifications/read-all', { method: 'POST' });
                void load(true);
              }}
            />
          )}
          {view === 'guardian' && (
            <Guardian
              controls={guardianControls}
              activity={guardianActivity}
              onSaved={() => {
                flash('Guardian spending limits updated.');
                void load(true);
              }}
            />
          )}
          {view === 'admin' && (
            <Admin
              admin={admin}
              users={profiles}
              onUpdate={() => {
                flash('Operations action recorded in the audit trail.');
                void load(true);
              }}
            />
          )}
          {view === 'settings' && <Settings me={me} flash={flash} onUpdated={() => void load(true)} />}
        </div>
      </main>

      {/* Contract Detail Modal */}
      {detail && (
        <ContractDetail
          detail={detail}
          me={me}
          onClose={() => setDetail(null)}
          flash={flash}
          reload={() => void load(true)}
        />
      )}

      {/* Counter Offer Modal */}
      {counterOfferTarget && (
        <CounterOfferModal
          contract={counterOfferTarget}
          onClose={() => setCounterOfferTarget(null)}
          onSubmitted={() => {
            flash('Counter-offer sent to the requester.');
            setCounterOfferTarget(null);
            void load(true);
          }}
        />
      )}

      {/* Courier Handoff Code Display Modal */}
      {handoffModal && (
        <div className="modal-layer">
          <section className="modal compact-modal">
            <button className="close" onClick={() => setHandoffModal(null)}>×</button>
            <span className="eyebrow">Safe-point custody code</span>
            <h2>{handoffModal.step === 'PICKUP' ? 'Pickup handoff' : 'Drop-off handoff'}</h2>
            <p>Show this code or visual matrix to the other party at the approved safe point.</p>
            <div className="qr-box">
              <div className="qr-matrix" />
              <div className="qr-code-display">{handoffModal.code}</div>
              <small>Expires in 10 minutes · Single-use</small>
            </div>
            <div className="qr-warning">
              <strong>Keep custody secure</strong>
              <p>{handoffModal.warning}</p>
            </div>
            <button className="primary" style={{ width: '100%', marginTop: '14px' }} onClick={() => setHandoffModal(null)}>
              Done
            </button>
          </section>
        </div>
      )}

      {/* Receiving Party Confirm Handoff Modal */}
      {confirmHandoffModal && (
        <ConfirmHandoffModal
          leg={confirmHandoffModal.leg}
          step={confirmHandoffModal.step}
          onClose={() => setConfirmHandoffModal(null)}
          onSuccess={() => {
            flash('Custody handoff verified. Status updated and ledger moved.');
            setConfirmHandoffModal(null);
            void load(true);
          }}
        />
      )}

      {/* Submit Report Modal */}
      {reportModal && (
        <ReportModal
          deliveryLegId={reportModal.deliveryLegId}
          contractId={reportModal.contractId}
          onClose={() => setReportModal(null)}
          onSuccess={() => {
            flash('Report submitted to Assingly operations.');
            setReportModal(null);
            void load(true);
          }}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Views & Components
// -----------------------------------------------------------------------------

function Home({ me, mine, delivery, notices, navigate, openContract }: {
  me: Me; mine: Contract[]; delivery: Delivery[]; notices: Notice[]; navigate: (view: View) => void; openContract: (contract: Contract) => void;
}) {
  const student = me.user.role === 'STUDENT';
  return (
    <>
      {student && (
        <section className="hero">
          <div>
            <span className="pill warm">Private by default</span>
            <h2>A calmer way to exchange <em>time</em>.</h2>
            <p>Use structured copying requests, approved safe points, and transparent Dime—not pressure or personal details.</p>
            <div className="hero-actions">
              <button className="primary" onClick={() => navigate('opportunities')}>Browse opportunities <span>→</span></button>
              <button className="secondary" onClick={() => navigate('create')}>Post a copying request</button>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <span className="scribble one">✦</span>
            <span className="scribble two">⌁</span>
            <div className="paper-card">
              <small>YOUR SPACE</small>
              <strong>Clear terms.<br />Safe handoffs.</strong>
              <div className="lines" />
            </div>
          </div>
        </section>
      )}

      {!student && (
        <section className="hero compact">
          <div>
            <span className="pill warm">Read-only by design</span>
            <h2>{me.user.role === 'GUARDIAN' ? 'Support the student’s controls.' : 'Keep the pilot safe and accountable.'}</h2>
            <p>
              {me.user.role === 'GUARDIAN'
                ? 'Review consent-linked limits and activity without participating in contracts or Dime transfers.'
                : 'Every consequential operations action is reasoned, auditable, and reversible through follow-up events.'}
            </p>
          </div>
        </section>
      )}

      <section className="stat-grid">
        <Stat title="Current Dime" value={money(me.wallet.available)} note="Spendable now" shade="cream" symbol="✺" />
        <Stat title="Locked Dime" value={money(me.wallet.locked)} note="Safely held in escrow" shade="lavender" symbol="◒" />
        <Stat title="Lifetime earned" value={money(me.wallet.lifetime_earned)} note="Never reduced by spending" shade="mint" symbol="↗" />
        <Stat title="Reliability" value={`${Math.max(0, 82 + me.reliability.score)}%`} note={`${me.reliability.events} substantiated event${me.reliability.events === 1 ? '' : 's'}`} shade="peach" symbol="◎" />
      </section>

      {me.guardian && (
        <section className="guardian-banner">
          <span>◌</span>
          <div>
            <strong>Guardian controls are active</strong>
            <p>{me.guardian.guardian_name} set a per-contract limit of {money(me.guardian.max_per_contract)} Dime and {money(me.guardian.max_per_rolling_period)} per 30-day period.</p>
          </div>
          <button onClick={() => navigate('settings')}>View controls</button>
        </section>
      )}

      <div className="section-head">
        <div>
          <span className="eyebrow">Your activity</span>
          <h2>Keep the next thing clear.</h2>
        </div>
        <button className="text-button" onClick={() => navigate('work')}>See all work →</button>
      </div>

      <div className="dashboard-grid">
        <section className="panel activity">
          <div className="panel-title">
            <h3>Active contracts</h3>
            <span>{mine.length} total</span>
          </div>
          {mine.length ? (
            mine.slice(0, 3).map((contract) => (
              <button className="activity-row" key={contract.id} onClick={() => openContract(contract)}>
                <span className="row-icon contract">✎</span>
                <span>
                  <strong>{contract.title}</strong>
                  <small>{contract.page_count} pages · {paperLabel(contract.paper_mode)}</small>
                </span>
                <span className={`badge ${contract.status.toLowerCase()}`}>{statusLabel(contract.status)}</span>
              </button>
            ))
          ) : (
            <Empty title="Nothing active yet" copy="Browse a copying or delivery opportunity when you're ready." />
          )}
        </section>

        <section className="panel delivery-mini">
          <div className="panel-title">
            <h3>Safe-point handoffs</h3>
            <button className="text-button" onClick={() => navigate('work')}>View all</button>
          </div>
          {delivery.length ? (
            delivery.slice(0, 2).map((leg) => (
              <div className="handoff" key={leg.id}>
                <div className="route">
                  <span>{leg.safe_point_name}</span>
                  <i />
                  <span>{statusLabel(leg.status)}</span>
                </div>
                <strong>{leg.item_description}</strong>
                <small>{money(leg.reward)} Dime · {statusLabel(leg.direction)}</small>
              </div>
            ))
          ) : (
            <Empty title="No handoffs to watch" copy="Approved locations and hours show up here." />
          )}
        </section>
      </div>

      <section className="panel updates-preview">
        <div className="panel-title">
          <h3>Recent updates</h3>
          <button className="text-button" onClick={() => navigate('inbox')}>Open updates →</button>
        </div>
        {notices.slice(0, 3).map((notice) => (
          <div className="update-row" key={notice.id}>
            <span className="notice-dot" />
            <div>
              <strong>{notice.title}</strong>
              <p>{notice.body}</p>
            </div>
            <small>{date(notice.created_at)}</small>
          </div>
        ))}
      </section>

      <section className="indicator-note">
        <span>◎</span>
        <div>
          <strong>What these indicators mean</strong>
          <p>
            Current Dime is spendable; locked Dime is escrow; lifetime earned only grows when work is released; reliability reflects substantiated outcomes—not spending, ordinary disputes, or convenience.
          </p>
        </div>
      </section>
    </>
  );
}

function Stat({ title, value, note, shade, symbol }: { title: string; value: string; note: string; shade: string; symbol: string }) {
  return (
    <article className={`stat ${shade}`}>
      <span className="stat-symbol">{symbol}</span>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function Empty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="empty">
      <span>⌁</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function Opportunities({
  contracts, delivery, onOpen, onAccept, onClaim, onCounter, me,
}: {
  contracts: Contract[];
  delivery: Delivery[];
  onOpen: (contract: Contract) => void;
  onAccept: (id: string) => void;
  onClaim: (id: string) => void;
  onCounter: (contract: Contract) => void;
  me: Me;
}) {
  const [tab, setTab] = useState<'writing' | 'delivery'>('writing');
  const [filter, setFilter] = useState('');
  const [paperFilter, setPaperFilter] = useState<string>('ALL');

  const listedContracts = contracts.filter((contract) => {
    const matchesText = `${contract.title} ${contract.paper_mode} ${contract.safe_point_name} ${contract.requester_name}`.toLowerCase().includes(filter.toLowerCase());
    const matchesPaper = paperFilter === 'ALL' || contract.paper_mode === paperFilter;
    return matchesText && matchesPaper;
  });

  const listedDelivery = delivery.filter((leg) => {
    return `${leg.item_description} ${leg.safe_point_name} ${leg.direction}`.toLowerCase().includes(filter.toLowerCase());
  });

  if (me.user.role !== 'STUDENT') return <AccessOnly />;

  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Marketplace</span>
          <h2>Choose what works for you.</h2>
          <p>Sort by practical fit—page count, reward, timing, or campus. No moralized score.</p>
        </div>
        <div className="search">
          <span>⌕</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search campus, paper, or task" />
        </div>
      </div>

      <div className="filter-row">
        <div className="tabs" style={{ marginBottom: 0, borderBottom: 0 }}>
          <button className={tab === 'writing' ? 'active' : ''} onClick={() => setTab('writing')}>
            Writing requests <span>{contracts.length}</span>
          </button>
          <button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>
            Delivery legs <span>{delivery.length}</span>
          </button>
        </div>
        {tab === 'writing' && (
          <select className="filter-select" value={paperFilter} onChange={(e) => setPaperFilter(e.target.value)}>
            <option value="ALL">All paper types</option>
            <option value="WRITER_SUPPLIED">Writer-supplied paper</option>
            <option value="REQUESTER_NOTEBOOK">Requester notebook</option>
          </select>
        )}
      </div>

      {tab === 'writing' ? (
        <div className="market-grid">
          {listedContracts.map((contract) => (
            <article className="opportunity" key={contract.id}>
              <div className="opportunity-top">
                <span className="paper-tag">{paperLabel(contract.paper_mode)}</span>
                <span className="reward">{money(contract.reward)} <small>Dime</small></span>
              </div>
              <h3>{contract.title}</h3>
              <p>{contract.summary}</p>
              <div className="op-meta">
                <span>◫ {contract.page_count} pages</span>
                <span>◷ Due {date(contract.deadline_at)}</span>
                <span>⌖ {contract.safe_point_name}</span>
                <span>👤 Posted by {contract.requester_name}</span>
              </div>
              <div className="op-footer">
                <button className="text-button" onClick={() => onOpen(contract)}>Review terms</button>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="secondary small" onClick={() => onCounter(contract)}>Counter-offer</button>
                  <button className="primary small" onClick={() => onAccept(contract.id)}>Accept</button>
                </div>
              </div>
            </article>
          ))}
          {!listedContracts.length && <Empty title="No matching writing requests" copy="Try a wider search or check back later." />}
        </div>
      ) : (
        <div className="market-grid">
          {listedDelivery.map((leg) => (
            <article className="opportunity delivery-card" key={leg.id}>
              <div className="opportunity-top">
                <span className="paper-tag purple">{statusLabel(leg.direction)}</span>
                <span className="reward">{money(leg.reward)} <small>Dime</small></span>
              </div>
              <h3>{leg.item_description}</h3>
              <p>Approved safe-point only. Custody is confirmed with a one-time code.</p>
              <div className="op-meta">
                <span>⌖ {leg.safe_point_name}</span>
                <span>◷ {leg.safe_point_hours || 'Check desk hours'}</span>
                <span>↔ For {leg.recipient_name}</span>
              </div>
              <div className="op-footer">
                <span className="privacy-note">No personal address</span>
                <button className="primary small" onClick={() => onClaim(leg.id)}>Claim delivery</button>
              </div>
            </article>
          ))}
          {!listedDelivery.length && <Empty title="No matching delivery legs" copy="New safe-point deliveries will appear here." />}
        </div>
      )}
    </>
  );
}

function CreateRequest({ onDone }: { onDone: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const tomorrow = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const [form, setForm] = useState({
    title: '',
    summary: '',
    paperMode: 'WRITER_SUPPLIED',
    pageCount: 3,
    reward: 480,
    deliveryReward: 50,
    deadlineAt: tomorrow,
    safePointId: 'safe-library',
    acceptanceCriteria: 'Ruled paper, blue or black pen, clear headings.',
    copyingAttested: false,
  });

  const update = (field: keyof typeof form, value: string | number | boolean) => setForm((c) => ({ ...c, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!file) return setError('Attach the complete source material before publishing.');
    setSending(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const asset = await api<{ data: { id: string } }>('/api/uploads/source', { method: 'POST', body });
      await api('/api/contracts', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          pageCount: Number(form.pageCount),
          reward: Number(form.reward),
          deliveryReward: Number(form.deliveryReward),
          deadlineAt: new Date(form.deadlineAt).toISOString(),
          sourceAssetId: asset.data.id,
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const totalEscrow = form.reward + (form.paperMode === 'REQUESTER_NOTEBOOK' ? form.deliveryReward * 2 : 0);

  return (
    <div className="create-layout">
      <section className="page-intro">
        <span className="eyebrow">New request</span>
        <h2>Set clear terms before anyone commits.</h2>
        <p>Only complete, authorized copying material can be posted. Prices, pages, and timing are all visible before Dime is locked.</p>
      </section>
      <form className="request-form" onSubmit={submit}>
        <fieldset>
          <legend>1. The copying work</legend>
          <label>
            Request title
            <input required value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="e.g. Copy seminar notes into clear pages" />
          </label>
          <label>
            What should be copied?
            <textarea required value={form.summary} onChange={(event) => update('summary', event.target.value)} placeholder="Describe the scope without asking for original answers or solutions." />
          </label>
          <div className="form-row">
            <label>
              Expected pages
              <input required type="number" min="1" max="100" value={form.pageCount} onChange={(event) => update('pageCount', Number(event.target.value))} />
            </label>
            <label>
              Deadline
              <input required type="datetime-local" value={form.deadlineAt} onChange={(event) => update('deadlineAt', event.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>2. Source and specifications</legend>
          <label className="upload">
            <span>⌁</span>
            <strong>{file ? file.name : 'Attach source material'}</strong>
            <small>PDF, TXT, JPG, PNG, or WebP · private · max 10MB</small>
            <input required type="file" accept=".pdf,.txt,image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <div className="choice-row">
            <button type="button" className={form.paperMode === 'WRITER_SUPPLIED' ? 'choice selected' : 'choice'} onClick={() => update('paperMode', 'WRITER_SUPPLIED')}>
              <strong>Writer-supplied paper</strong>
              <small>No inbound notebook delivery.</small>
            </button>
            <button type="button" className={form.paperMode === 'REQUESTER_NOTEBOOK' ? 'choice selected' : 'choice'} onClick={() => update('paperMode', 'REQUESTER_NOTEBOOK')}>
              <strong>Requester-supplied notebook</strong>
              <small>Two separately funded safe-point legs.</small>
            </button>
          </div>
          <label>
            Acceptance criteria
            <textarea required value={form.acceptanceCriteria} onChange={(event) => update('acceptanceCriteria', event.target.value)} />
          </label>
        </fieldset>

        <fieldset>
          <legend>3. Dime and safe handoff</legend>
          <div className="form-row">
            <label>
              Writing reward
              <input type="number" min="10" value={form.reward} onChange={(event) => update('reward', Number(event.target.value))} />
            </label>
            {form.paperMode === 'REQUESTER_NOTEBOOK' && (
              <label>
                Each delivery leg
                <input type="number" min="1" value={form.deliveryReward} onChange={(event) => update('deliveryReward', Number(event.target.value))} />
              </label>
            )}
            <label>
              Approved safe point
              <select value={form.safePointId} onChange={(event) => update('safePointId', event.target.value)}>
                <option value="safe-library">Library Help Desk</option>
                <option value="safe-gate">North Gate Security Desk</option>
              </select>
            </label>
          </div>
          <div className="escrow-preview">
            <span>◒</span>
            <div>
              <strong>{money(totalEscrow)} Dime will be locked</strong>
              <p>Locked Dime is held until page review, delivery confirmation, refund, or an audited resolution.</p>
            </div>
          </div>
        </fieldset>

        <label className="attestation">
          <input required type="checkbox" checked={form.copyingAttested} onChange={(event) => update('copyingAttested', event.target.checked)} />
          <span>I confirm this source is complete, authorized for copying, and does not ask for answers, problem solving, examinations, or original work.</span>
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="primary" disabled={sending}>
            {sending ? 'Publishing securely…' : 'Review & publish request →'}
          </button>
          <p>You can cancel before a writer accepts. Accepted terms stay versioned and immutable.</p>
        </div>
      </form>
    </div>
  );
}

function MyWork({
  mine, delivery, me, onOpen, onCancel, onInitiateHandoff, onConfirmHandoff, onReport,
}: {
  mine: Contract[];
  delivery: Delivery[];
  me: Me;
  onOpen: (contract: Contract) => void;
  onCancel: (id: string) => void;
  onInitiateHandoff: (leg: Delivery, step: 'PICKUP' | 'DROPOFF') => void;
  onConfirmHandoff: (leg: Delivery, step: 'PICKUP' | 'DROPOFF') => void;
  onReport: (leg: Delivery) => void;
}) {
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Your contracts</span>
          <h2>Every step stays visible.</h2>
          <p>Terms, page evidence, delivery custody, and settlement are all tracked separately.</p>
        </div>
      </div>

      <section className="work-list">
        {mine.map((contract) => {
          const isRequester = contract.requester_id === me.user.id;
          const isPastGrace = Date.now() > new Date(contract.deadline_at).getTime() + 24 * 3600 * 1000;
          return (
            <article className="work-card" key={contract.id}>
              <div className="work-main">
                <span className="row-icon contract">✎</span>
                <div>
                  <div className="inline-meta">
                    <span className={`badge ${contract.status.toLowerCase()}`}>{statusLabel(contract.status)}</span>
                    <span>{paperLabel(contract.paper_mode)}</span>
                    <span>{isRequester ? 'You requested' : `Writer: ${contract.writer_name || 'Assigned'}`}</span>
                  </div>
                  <h3>{contract.title}</h3>
                  <p>{contract.page_count} pages · {money(contract.reward)} Dime · due {date(contract.deadline_at)}</p>
                </div>
              </div>
              <div className="work-actions">
                <button className="secondary small" onClick={() => onOpen(contract)}>Open progress</button>
                {isRequester && contract.status === 'OPEN' && (
                  <button className="danger-link" onClick={() => onCancel(contract.id)}>Cancel & release</button>
                )}
                {isRequester && ['ACCEPTED', 'IN_PROGRESS'].includes(contract.status) && isPastGrace && (
                  <button className="danger-link" onClick={() => onCancel(contract.id)}>Eligible late cancellation</button>
                )}
              </div>
            </article>
          );
        })}
        {!mine.length && <Empty title="No contracts yet" copy="Your accepted or published work will appear here." />}
      </section>

      <div className="section-head small-head">
        <div>
          <span className="eyebrow">Delivery custody</span>
          <h2>Safe-point handoffs & proof.</h2>
        </div>
      </div>

      <section className="work-list">
        {delivery.map((leg) => {
          const isCourier = leg.courier_id === me.user.id;
          const isParty = leg.requester_id === me.user.id || leg.recipient_id === me.user.id;
          return (
            <article className="work-card" key={leg.id}>
              <div className="work-main">
                <span className="row-icon delivery">↔</span>
                <div>
                  <div className="inline-meta">
                    <span className={`badge ${leg.status.toLowerCase()}`}>{statusLabel(leg.status)}</span>
                    <span>{statusLabel(leg.direction)}</span>
                    {isCourier && <span>You are courier</span>}
                  </div>
                  <h3>{leg.item_description}</h3>
                  <p>{leg.safe_point_name} · {money(leg.reward)} Dime reward</p>
                </div>
              </div>
              <div className="work-actions">
                {isCourier && leg.status === 'CLAIMED' && (
                  <button className="primary small" onClick={() => onInitiateHandoff(leg, 'PICKUP')}>
                    Initiate pickup code
                  </button>
                )}
                {isParty && leg.status === 'CLAIMED' && (
                  <button className="secondary small" onClick={() => onConfirmHandoff(leg, 'PICKUP')}>
                    Confirm pickup handoff
                  </button>
                )}
                {isCourier && leg.status === 'PICKUP_CONFIRMED' && (
                  <button className="primary small" onClick={() => onInitiateHandoff(leg, 'DROPOFF')}>
                    Initiate drop-off code
                  </button>
                )}
                {isParty && leg.status === 'PICKUP_CONFIRMED' && (
                  <button className="secondary small" onClick={() => onConfirmHandoff(leg, 'DROPOFF')}>
                    Confirm drop-off handoff
                  </button>
                )}
                <button className="text-button" onClick={() => onReport(leg)}>Report issue</button>
              </div>
            </article>
          );
        })}
        {!delivery.length && <Empty title="No delivery legs yet" copy="Notebook and independent delivery status appears separately." />}
      </section>
    </>
  );
}

function Wallet({ me, ledger }: { me: Me; ledger: any[] }) {
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Dime wallet</span>
          <h2>Understand every movement.</h2>
          <p>Dime is an internal, non-cashable unit. It is not a purchase balance and cannot be withdrawn or transferred directly.</p>
        </div>
      </div>
      <section className="wallet-hero">
        <div>
          <span>AVAILABLE TO COMMIT</span>
          <strong>{money(me.wallet.available)} <small>Dime</small></strong>
          <p>Current Dime can fund eligible contracts.</p>
        </div>
        <div>
          <span>IN ESCROW</span>
          <strong>{money(me.wallet.locked)} <small>Dime</small></strong>
          <p>Held until page review or custody confirmation.</p>
        </div>
        <div>
          <span>ALL-TIME EARNED</span>
          <strong>{money(me.wallet.lifetime_earned)} <small>Dime</small></strong>
          <p>Released earnings only; spending never changes this.</p>
        </div>
      </section>
      <section className="panel ledger">
        <div className="panel-title">
          <div>
            <h3>Append-only ledger</h3>
            <p>Corrections use a linked adjustment, never a silent edit.</p>
          </div>
          <span className="ledger-seal">✓ Auditable</span>
        </div>
        {ledger.map((line) => (
          <div className="ledger-row" key={line.id}>
            <span className={`ledger-icon ${line.kind.toLowerCase()}`}>
              {line.kind === 'SETTLEMENT' ? '↗' : line.kind === 'ESCROW_LOCK' ? '◒' : '✦'}
            </span>
            <div>
              <strong>{line.reason}</strong>
              <small>{date(line.created_at)} · {statusLabel(line.kind)}</small>
            </div>
            <div className="ledger-values">
              <strong className={line.available_delta < 0 ? 'negative' : ''}>
                {line.available_delta > 0 ? '+' : ''}{money(line.available_delta)}
              </strong>
              {line.locked_delta !== 0 && (
                <small>locked {line.locked_delta > 0 ? '+' : ''}{money(line.locked_delta)}</small>
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function Inbox({ notices, onRead, onReadAll }: { notices: Notice[]; onRead: (id: string) => void; onReadAll: () => void }) {
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Private updates</span>
          <h2>Only the information you need.</h2>
          <p>Notifications do not include source contents, evidence, precise locations, or reusable handoff codes.</p>
        </div>
        {notices.some((n) => !n.read_at) && (
          <button className="secondary small" onClick={onReadAll}>Mark all as read</button>
        )}
      </div>
      <section className="panel inbox">
        {notices.map((notice) => (
          <button className={`inbox-row ${notice.read_at ? '' : 'unread'}`} key={notice.id} onClick={() => onRead(notice.id)}>
            <span className="notice-icon">
              {notice.kind === 'SETTLEMENT' ? '✦' : notice.kind === 'HANDOFF' ? '↔' : '◌'}
            </span>
            <span>
              <strong>{notice.title}</strong>
              <p>{notice.body}</p>
            </span>
            <small>{date(notice.created_at)}</small>
          </button>
        ))}
        {!notices.length && <Empty title="All caught up" copy="Important contract and safety updates will appear here." />}
      </section>
    </>
  );
}

function Guardian({ controls, activity, onSaved }: { controls: any[]; activity: any | null; onSaved: () => void }) {
  const [editing, setEditing] = useState<any | null>(null);
  const [perContract, setPerContract] = useState(0);
  const [perPeriod, setPerPeriod] = useState(0);

  const save = async () => {
    if (!editing) return;
    await api('/api/guardian/controls', {
      method: 'PUT',
      body: JSON.stringify({
        studentId: editing.student_id,
        maxPerContract: Number(perContract),
        maxPerRollingPeriod: Number(perPeriod),
      }),
    });
    setEditing(null);
    onSaved();
  };

  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Guardian controls</span>
          <h2>Limits without taking over.</h2>
          <p>Guardians can review consent-linked settings and activity. They cannot fund, request, accept, write, courier, negotiate, or transfer Dime.</p>
        </div>
      </div>
      <section className="guardian-grid">
        {controls.map((control) => (
          <article className="guardian-card" key={control.student_id}>
            <span className="avatar large">{control.student_name[0]}</span>
            <h3>{control.student_name}</h3>
            <p>Verified student · consent active</p>
            <div>
              <span>Per contract<strong>{money(control.max_per_contract)} Dime</strong></span>
              <span>Rolling period<strong>{money(control.max_per_rolling_period)} Dime / {control.rolling_period_days}d</strong></span>
            </div>
            <button className="secondary" onClick={() => {
              setEditing(control);
              setPerContract(control.max_per_contract);
              setPerPeriod(control.max_per_rolling_period);
            }}>
              Adjust limits
            </button>
          </article>
        ))}
      </section>

      {activity && (
        <div style={{ marginTop: '30px' }}>
          <div className="section-head small-head">
            <div>
              <span className="eyebrow">Read-only student activity</span>
              <h2>Contracts & spending records.</h2>
            </div>
          </div>
          <div className="dashboard-grid">
            <section className="panel">
              <div className="panel-title"><h3>Recent contracts funded</h3></div>
              {activity.contracts?.length ? (
                activity.contracts.map((c: any) => (
                  <div className="activity-row" key={c.id}>
                    <span className="row-icon contract">✎</span>
                    <span>
                      <strong>{c.title}</strong>
                      <small>{money(c.reward)} Dime · {c.student_name}</small>
                    </span>
                    <span className={`badge ${c.status.toLowerCase()}`}>{statusLabel(c.status)}</span>
                  </div>
                ))
              ) : <p style={{ fontSize: '12px', color: '#778' }}>No contract activity yet.</p>}
            </section>
            <section className="panel">
              <div className="panel-title"><h3>Ledger movements</h3></div>
              {activity.ledger?.length ? (
                activity.ledger.slice(0, 5).map((l: any) => (
                  <div className="activity-row" key={l.id}>
                    <span>
                      <strong>{l.reason}</strong>
                      <small>{date(l.created_at)}</small>
                    </span>
                    <strong>{l.available_delta > 0 ? '+' : ''}{money(l.available_delta)}</strong>
                  </div>
                ))
              ) : <p style={{ fontSize: '12px', color: '#778' }}>No ledger movements.</p>}
            </section>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-layer">
          <section className="modal compact-modal">
            <button className="close" onClick={() => setEditing(null)}>×</button>
            <span className="eyebrow">Guardian control</span>
            <h2>Set clear Dime limits</h2>
            <label>
              Maximum per contract
              <input type="number" min="0" value={perContract} onChange={(event) => setPerContract(Number(event.target.value))} />
            </label>
            <label>
              Maximum per 30-day period
              <input type="number" min="0" value={perPeriod} onChange={(event) => setPerPeriod(Number(event.target.value))} />
            </label>
            <button className="primary" onClick={() => void save()}>Save limits</button>
          </section>
        </div>
      )}
    </>
  );
}

function Admin({ admin, users, onUpdate }: { admin: any; users: DemoUser[]; onUpdate: () => void }) {
  const [tab, setTab] = useState<'disputes' | 'verification' | 'safepoints' | 'reports' | 'restrictions' | 'grants' | 'audit'>('disputes');
  const [safe, setSafe] = useState({ name: '', campus: 'Northfield Campus', area: '', hours: '' });
  const [grant, setGrant] = useState({ userId: 'stu-aanya', amount: 500, reason: 'Pilot testing grant' });
  const [restrictTarget, setRestrictTarget] = useState({ userId: 'stu-kabir', reason: 'Repeated late work with no submission' });
  const [activeDisputeModal, setActiveDisputeModal] = useState<any | null>(null);

  if (!admin) return <div className="splash">Loading operations data…</div>;

  const handleResolveDispute = async (outcome: string, percent?: number, reasonText?: string, flagMisuse?: boolean) => {
    if (!reasonText) return;
    await api(`/api/admin/disputes/${activeDisputeModal.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome, completionPercent: percent, reason: reasonText, flagDeliberateMisuse: flagMisuse }),
    });
    setActiveDisputeModal(null);
    onUpdate();
  };

  const handleVerify = async (userId: string, verified: boolean) => {
    await api(`/api/admin/users/${userId}/verify`, {
      method: 'POST',
      body: JSON.stringify({ verified, reason: 'Operations pilot review' }),
    });
    onUpdate();
  };

  const addPoint = async (event: FormEvent) => {
    event.preventDefault();
    await api('/api/admin/safe-points', { method: 'POST', body: JSON.stringify(safe) });
    setSafe({ name: '', campus: 'Northfield Campus', area: '', hours: '' });
    onUpdate();
  };

  const toggleSafe = async (pointId: string, currentActive: number) => {
    await api(`/api/admin/safe-points/${pointId}`, {
      method: 'PUT',
      body: JSON.stringify({ active: !currentActive }),
    });
    onUpdate();
  };

  const submitGrant = async (e: FormEvent) => {
    e.preventDefault();
    await api('/api/admin/grants', {
      method: 'POST',
      body: JSON.stringify({
        userId: grant.userId,
        amount: Number(grant.amount),
        reason: grant.reason,
        idempotencyKey: `manual-grant-${Date.now()}-${Math.random()}`,
      }),
    });
    onUpdate();
  };

  const submitRestrict = async (restricted: boolean) => {
    await api(`/api/admin/users/${restrictTarget.userId}/restrict`, {
      method: 'POST',
      body: JSON.stringify({ restricted, reason: restrictTarget.reason }),
    });
    onUpdate();
  };

  const resolveReport = async (reportId: string) => {
    const note = window.prompt('Resolution note for audit trail:');
    if (!note) return;
    await api(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    onUpdate();
  };

  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Moderator-only</span>
          <h2>Operate with context, not shortcuts.</h2>
          <p>Decisions require reasons. Wallet records and evidence remain append-only and sensitive reads are logged.</p>
        </div>
      </div>

      <section className="admin-stats">
        <Stat title="Open disputes" value={String(admin.disputes.length)} note="Page-specific review" shade="peach" symbol="!" />
        <Stat title="Verification queue" value={String(admin.verification.length)} note="Pilot student checks" shade="cream" symbol="✓" />
        <Stat title="Active safe points" value={String(admin.safePoints.filter((point: any) => point.active).length)} note="Platform-managed only" shade="mint" symbol="⌖" />
      </section>

      <div className="admin-subnav">
        <button className={tab === 'disputes' ? 'active' : ''} onClick={() => setTab('disputes')}>Disputes ({admin.disputes.length})</button>
        <button className={tab === 'verification' ? 'active' : ''} onClick={() => setTab('verification')}>Verification ({admin.verification.length})</button>
        <button className={tab === 'safepoints' ? 'active' : ''} onClick={() => setTab('safepoints')}>Safe points</button>
        <button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Reports ({admin.reports.length})</button>
        <button className={tab === 'restrictions' ? 'active' : ''} onClick={() => setTab('restrictions')}>Restrictions</button>
        <button className={tab === 'grants' ? 'active' : ''} onClick={() => setTab('grants')}>Platform grants</button>
      </div>

      {tab === 'disputes' && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Page disputes</h3>
              <p>Adjudicate based on contract terms, source text, and submitted evidence. OCR is advisory only.</p>
            </div>
          </div>
          {admin.disputes.length ? (
            admin.disputes.map((dispute: any) => (
              <div className="case-row" key={dispute.id}>
                <div>
                  <strong>{dispute.title} — Page {dispute.page_number}</strong>
                  <p>Reason: {statusLabel(dispute.reason)} · Requester: {dispute.requester_name} · Writer: {dispute.writer_name || 'Assigned'}</p>
                  <small style={{ color: '#888' }}>Receipt hash: {dispute.receipt_hash?.slice(0, 16)}… · Note: "{dispute.note || 'None'}"</small>
                </div>
                <div>
                  <button className="primary small" onClick={() => setActiveDisputeModal(dispute)}>Review & adjudicate</button>
                </div>
              </div>
            ))
          ) : (
            <Empty title="No open disputes" copy="When one arrives, terms, source, evidence, and ledger impact will be reviewed together." />
          )}
        </section>
      )}

      {tab === 'verification' && (
        <section className="panel">
          <div className="panel-title"><h3>Student verification queue</h3></div>
          {admin.verification.length ? (
            admin.verification.map((u: any) => (
              <div className="case-row" key={u.id}>
                <div>
                  <strong>{u.display_name}</strong>
                  <p>{u.campus || 'No campus'} · Age {u.age} · Requested {date(u.created_at)}</p>
                </div>
                <div>
                  <button className="primary small" onClick={() => void handleVerify(u.id, true)}>Approve verification</button>
                  <button className="secondary small" onClick={() => void handleVerify(u.id, false)}>Reject</button>
                </div>
              </div>
            ))
          ) : <Empty title="Verification queue empty" copy="No students currently awaiting verification." />}
        </section>
      )}

      {tab === 'safepoints' && (
        <div className="admin-grid">
          <section className="panel">
            <div className="panel-title"><h3>Managed safe points</h3></div>
            {admin.safePoints.map((point: any) => (
              <div className="safe-row" key={point.id}>
                <span>⌖</span>
                <div>
                  <strong>{point.name}</strong>
                  <p>{point.campus} · {point.area} · {point.hours}</p>
                </div>
                <button className="secondary small" onClick={() => void toggleSafe(point.id, point.active)}>
                  {point.active ? 'Active' : 'Inactive'}
                </button>
              </div>
            ))}
          </section>
          <section className="panel">
            <div className="panel-title"><h3>Add approved safe point</h3></div>
            <form className="safe-form" onSubmit={addPoint}>
              <input required placeholder="Safe-point name" value={safe.name} onChange={(e) => setSafe({ ...safe, name: e.target.value })} />
              <input required placeholder="Campus" value={safe.campus} onChange={(e) => setSafe({ ...safe, campus: e.target.value })} />
              <input required placeholder="Staffed area / desk" value={safe.area} onChange={(e) => setSafe({ ...safe, area: e.target.value })} />
              <input required placeholder="Operating hours" value={safe.hours} onChange={(e) => setSafe({ ...safe, hours: e.target.value })} />
              <button className="primary small" type="submit">Create safe point</button>
            </form>
          </section>
        </div>
      )}

      {tab === 'reports' && (
        <section className="panel">
          <div className="panel-title"><h3>Open delivery & safety reports</h3></div>
          {admin.reports.length ? (
            admin.reports.map((r: any) => (
              <div className="case-row" key={r.id}>
                <div>
                  <strong>{r.kind}</strong>
                  <p>{r.detail}</p>
                  <small style={{ color: '#888' }}>Reporter: {r.reporter_name} · Filed: {date(r.created_at)}</small>
                </div>
                <div>
                  <button className="secondary small" onClick={() => void resolveReport(r.id)}>Resolve with note</button>
                </div>
              </div>
            ))
          ) : <Empty title="No open reports" copy="All safety and custody reports are resolved." />}
        </section>
      )}

      {tab === 'restrictions' && (
        <div className="admin-grid">
          <section className="panel">
            <div className="panel-title"><h3>Currently restricted students</h3></div>
            {admin.restrictions.length ? (
              admin.restrictions.map((r: any) => (
                <div className="case-row" key={r.id}>
                  <div>
                    <strong>{r.display_name}</strong>
                    <p>Reason: {r.restriction_reason}</p>
                  </div>
                  <div>
                    <button className="secondary small" onClick={() => { setRestrictTarget({ userId: r.id, reason: 'Restoration review completed' }); void submitRestrict(false); }}>
                      Lift restriction
                    </button>
                  </div>
                </div>
              ))
            ) : <p style={{ fontSize: '12px', color: '#778' }}>No accounts are currently restricted.</p>}
          </section>
          <section className="panel">
            <div className="panel-title"><h3>Restrict a student account</h3></div>
            <form onSubmit={(e) => { e.preventDefault(); void submitRestrict(true); }}>
              <label style={{ display: 'grid', gap: '6px', fontSize: '12px', margin: '10px 0' }}>
                Select student:
                <select value={restrictTarget.userId} onChange={(e) => setRestrictTarget({ ...restrictTarget, userId: e.target.value })}>
                  {users.filter((u) => u.role === 'STUDENT').map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'grid', gap: '6px', fontSize: '12px', margin: '10px 0' }}>
                Reason for restriction:
                <textarea required value={restrictTarget.reason} onChange={(e) => setRestrictTarget({ ...restrictTarget, reason: e.target.value })} />
              </label>
              <button className="danger-link" type="submit" style={{ padding: '8px 12px', background: '#ffe6e1', borderRadius: '6px' }}>
                Apply account restriction
              </button>
            </form>
          </section>
        </div>
      )}

      {tab === 'grants' && (
        <section className="panel" style={{ maxWidth: '600px' }}>
          <div className="panel-title"><h3>Audited platform Dime grant</h3></div>
          <form onSubmit={submitGrant}>
            <label style={{ display: 'grid', gap: '6px', fontSize: '12px', margin: '12px 0' }}>
              Student recipient:
              <select value={grant.userId} onChange={(e) => setGrant({ ...grant, userId: e.target.value })}>
                {users.filter((u) => u.role === 'STUDENT').map((u) => (
                  <option key={u.id} value={u.id}>{u.display_name}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '12px', margin: '12px 0' }}>
              Grant amount (Dime):
              <input type="number" min="1" max="100000" value={grant.amount} onChange={(e) => setGrant({ ...grant, amount: Number(e.target.value) })} />
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '12px', margin: '12px 0' }}>
              Audited reason:
              <input required value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} />
            </label>
            <button className="primary small" type="submit">Issue platform grant</button>
          </form>
        </section>
      )}

      {activeDisputeModal && (
        <DisputeResolutionModal
          dispute={activeDisputeModal}
          onClose={() => setActiveDisputeModal(null)}
          onResolve={handleResolveDispute}
        />
      )}
    </>
  );
}

function Settings({ me, flash, onUpdated }: { me: Me; flash: (text: string, type?: 'good' | 'bad') => void; onUpdated: () => void }) {
  const requestVerification = async () => {
    try {
      await api('/api/verification/request', { method: 'POST' });
      flash('Verification request sent to local operations review.');
      onUpdated();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">Account & privacy</span>
          <h2>Only collect what the pilot needs.</h2>
          <p>Your public marketplace identity uses a chosen display name and campus fit—not a home address or contact details.</p>
        </div>
      </div>
      <section className="settings-grid">
        <article className="panel profile-card">
          <span className="avatar huge">{me.user.display_name[0]}</span>
          <h3>{me.user.display_name}</h3>
          <p>{me.user.role.toLowerCase()} · {me.user.campus || 'Operations'}</p>
          <span className={`verification ${me.user.verified_at ? 'verified' : ''}`}>
            {me.user.verified_at ? '✓ Demo verified' : '◌ Verification needed'}
          </span>
          {me.user.role === 'STUDENT' && !me.user.verified_at && (
            <button className="primary small" onClick={() => void requestVerification()}>
              Request pilot verification
            </button>
          )}
        </article>
        <article className="panel">
          <h3>Privacy & safety defaults</h3>
          <ul className="check-list">
            <li>Private source and page evidence access</li>
            <li>Approved safe points only</li>
            <li>Structured offers—no open-ended price chat</li>
            <li>One-time custody codes; no reusable code notifications</li>
            <li>Block, report, and moderator-review paths</li>
          </ul>
        </article>
        <article className="panel">
          <h3>Academic-integrity boundary</h3>
          <p>Assingly permits copying complete, authorized source material. It does not solve problems, create answers, complete exams, or generate original work for submission.</p>
          <p style={{ marginTop: '10px', fontSize: '11px', color: '#888' }}>
            Merchant redemption is an architectural seam disabled by default. Real-money operations and token cash-outs are prohibited.
          </p>
        </article>
      </section>
    </>
  );
}

function ContractDetail({ detail, me, onClose, flash, reload }: {
  detail: any; me: Me; onClose: () => void; flash: (text: string, type?: 'good' | 'bad') => void; reload: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [page, setPage] = useState(1);
  const [disputePageModal, setDisputePageModal] = useState<any | null>(null);
  const [activeOcrComparison, setActiveOcrComparison] = useState<any | null>(null);

  const isRequester = detail.requester_id === me.user.id;
  const isWriter = detail.writer_id === me.user.id;

  const submitEvidence = async () => {
    if (!file) return flash('Choose a private page image first.', 'bad');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('pageNumber', String(page));
      await api(`/api/contracts/${detail.id}/evidence`, { method: 'POST', body: form });
      flash('Page evidence received. Advisory OCR processing started.');
      setFile(null);
      reload();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const acceptPage = async (evidenceId: string) => {
    try {
      await api(`/api/contracts/${detail.id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ evidenceId, action: 'ACCEPT' }),
      });
      flash('Page accepted.');
      reload();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const runAutoAccept = async () => {
    try {
      const res = await api<{ data: { autoAcceptedPages: number } }>(`/api/contracts/${detail.id}/auto-accept`, { method: 'POST' });
      flash(`Auto-accepted ${res.data.autoAcceptedPages} page(s) per 48-hour policy.`);
      reload();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const acceptCounterOffer = async (offerId: string) => {
    try {
      await api(`/api/contracts/${detail.id}/offers/${offerId}/accept`, { method: 'POST' });
      flash('Counter-offer accepted! Terms updated.');
      reload();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const declineCounterOffer = async (offerId: string) => {
    try {
      await api(`/api/contracts/${detail.id}/offers/${offerId}/decline`, { method: 'POST' });
      flash('Counter-offer declined.');
      reload();
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  const viewOcr = async (pageNumber: number) => {
    try {
      const res = await api<{ data: any }>(`/api/contracts/${detail.id}/ocr-comparison/${pageNumber}`);
      setActiveOcrComparison(res.data);
    } catch (error) {
      flash((error as Error).message, 'bad');
    }
  };

  return (
    <div className="modal-layer">
      <section className="modal detail-modal">
        <button className="close" onClick={onClose}>×</button>
        <span className={`badge ${detail.status.toLowerCase()}`}>{statusLabel(detail.status)}</span>
        <h2>{detail.title}</h2>
        <p className="detail-summary">{detail.summary}</p>

        <div className="detail-grid">
          <div>
            <span>Writing reward</span>
            <strong>{money(detail.reward)} Dime</strong>
          </div>
          <div>
            <span>Pages</span>
            <strong>{detail.page_count}</strong>
          </div>
          <div>
            <span>Due</span>
            <strong>{date(detail.deadline_at)}</strong>
          </div>
          <div>
            <span>Approved safe point</span>
            <strong>{detail.safe_point_name}</strong>
          </div>
        </div>

        <section className="terms">
          <h3>Accepted terms</h3>
          <p>{detail.acceptance_criteria}</p>
          <p>
            <b>Paper:</b> {paperLabel(detail.paper_mode)} · <b>Late policy:</b> 10% per started 24h, capped at 50%.
          </p>
          {detail.source_asset_id && (
            <p>
              <b>Source asset:</b> <a href={`/api/assets/${detail.source_asset_id}`} target="_blank" rel="noreferrer" style={{ color: '#2b5757' }}>
                Download private source ({detail.source_name || 'Attached file'})
              </a>
            </p>
          )}
        </section>

        {/* Counter-offers list (for OPEN requests) */}
        {detail.status === 'OPEN' && detail.offers && detail.offers.length > 0 && (
          <section className="terms">
            <h3>Structured counter-offers ({detail.offers.length})</h3>
            <div className="offers-list">
              {detail.offers.map((offer: any) => (
                <div className="offer-card" key={offer.id}>
                  <div>
                    <strong>{offer.proposer_name}: {offer.reward ? `${money(offer.reward)} Dime` : 'Terms adjustment'}</strong>
                    <p>
                      {offer.page_count && `${offer.page_count} pages`} {offer.deadline_at && `· due ${date(offer.deadline_at)}`}
                      {offer.note && ` · "${offer.note}"`}
                    </p>
                  </div>
                  <div className="offer-actions">
                    <span className={`badge ${offer.status.toLowerCase()}`}>{offer.status}</span>
                    {isRequester && offer.status === 'PENDING' && (
                      <>
                        <button className="primary small" onClick={() => void acceptCounterOffer(offer.id)}>Accept</button>
                        <button className="secondary small" onClick={() => void declineCounterOffer(offer.id)}>Decline</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Page Evidence & Review Section */}
        {detail.evidence && (
          <section className="evidence-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Page evidence <span>OCR is advisory only</span></h3>
              {isRequester && ['SUBMITTED', 'IN_REVIEW'].includes(detail.status) && (
                <button className="secondary small" onClick={() => void runAutoAccept()}>Test 48h auto-accept</button>
              )}
            </div>
            {detail.evidence.map((ev: any) => {
              const review = detail.reviews?.find((r: any) => r.evidence_id === ev.id);
              return (
                <div className="page-review-row" key={ev.id}>
                  <div className="page-thumb">P{ev.page_number}</div>
                  <div className="page-meta">
                    <strong>Page {ev.page_number}</strong>
                    <small>
                      Hash: {ev.receipt_hash?.slice(0, 14)}… ·
                      OCR: <span className={`badge ${ev.ocr_status.toLowerCase()}`}>{ev.ocr_status}</span>
                      {review && <span> · Review: <span className={`badge ${review.status.toLowerCase()}`}>{review.status}</span></span>}
                    </small>
                  </div>
                  <div className="page-actions">
                    <button className="text-button" onClick={() => void viewOcr(ev.page_number)}>Advisory OCR</button>
                    {isRequester && !review && ['SUBMITTED', 'IN_REVIEW'].includes(detail.status) && (
                      <>
                        <button className="secondary small" onClick={() => void acceptPage(ev.id)}>Accept</button>
                        <button className="danger-link" onClick={() => setDisputePageModal(ev)}>Dispute</button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {detail.evidence.length === 0 && <p style={{ fontSize: '12px', color: '#778' }}>No evidence submitted yet.</p>}
          </section>
        )}

        {/* Writer Upload Completed Page */}
        {isWriter && ['ACCEPTED', 'IN_PROGRESS'].includes(detail.status) && (
          <section className="evidence-upload">
            <h3>Submit a completed page</h3>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' }}>
              <input type="number" min="1" max={detail.page_count} value={page} onChange={(event) => setPage(Number(event.target.value))} />
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] || null)} />
              <button className="primary small" onClick={() => void submitEvidence()}>Submit page photo</button>
            </div>
          </section>
        )}

        {activeOcrComparison && (
          <div className="comparison-box">
            <h4>Advisory OCR Analysis (Page {activeOcrComparison.pageNumber})</h4>
            <p><strong>Keyword correspondence:</strong> {activeOcrComparison.coveragePercent}%</p>
            <p className="advisory-badge">{activeOcrComparison.advisoryNote}</p>
            <p style={{ fontSize: '11px', color: '#68736e', marginTop: '6px' }}>{activeOcrComparison.disclaimer}</p>
            <button className="text-button" onClick={() => setActiveOcrComparison(null)}>Close preview</button>
          </div>
        )}

        {disputePageModal && (
          <DisputePageModal
            contractId={detail.id}
            evidence={disputePageModal}
            onClose={() => setDisputePageModal(null)}
            onSuccess={() => {
              flash('Page disputed. Placed in operations queue.');
              setDisputePageModal(null);
              reload();
            }}
          />
        )}

        <p className="modal-foot">
          Source and evidence stay private to contract parties and authorised operations reviewers. Content hashes prove receipt integrity, not authorship.
        </p>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Interactive Workflow Modals
// -----------------------------------------------------------------------------

function CounterOfferModal({ contract, onClose, onSubmitted }: { contract: Contract; onClose: () => void; onSubmitted: () => void }) {
  const [reward, setReward] = useState(contract.reward);
  const [pageCount, setPageCount] = useState(contract.page_count);
  const [deadlineAt, setDeadlineAt] = useState(contract.deadline_at.slice(0, 16));
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await api(`/api/contracts/${contract.id}/offers`, {
        method: 'POST',
        body: JSON.stringify({
          reward: Number(reward),
          pageCount: Number(pageCount),
          deadlineAt: new Date(deadlineAt).toISOString(),
          note,
        }),
      });
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-layer">
      <section className="modal compact-modal">
        <button className="close" onClick={onClose}>×</button>
        <span className="eyebrow">Structured offer</span>
        <h2>Counter-offer</h2>
        <p>Propose revised terms without free-form chat. Terms remain structured and auditable.</p>
        <form onSubmit={submit}>
          <label>
            Proposed writing reward (Dime)
            <input type="number" min="10" value={reward} onChange={(e) => setReward(Number(e.target.value))} />
          </label>
          <label>
            Proposed page count
            <input type="number" min="1" max="100" value={pageCount} onChange={(e) => setPageCount(Number(e.target.value))} />
          </label>
          <label>
            Proposed deadline
            <input type="datetime-local" value={deadlineAt} onChange={(e) => setDeadlineAt(e.target.value)} />
          </label>
          <label>
            Note to requester (e.g. calligraphy style, availability)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Brief note" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" style={{ width: '100%', marginTop: '14px' }} type="submit" disabled={sending}>
            {sending ? 'Sending offer…' : 'Send structured counter-offer'}
          </button>
        </form>
      </section>
    </div>
  );
}

function ConfirmHandoffModal({ leg, step, onClose, onSuccess }: { leg: Delivery; step: 'PICKUP' | 'DROPOFF'; onClose: () => void; onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await api(`/api/delivery/${leg.id}/handoff/confirm`, {
        method: 'POST',
        body: JSON.stringify({ step, code }),
      });
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-layer">
      <section className="modal compact-modal">
        <button className="close" onClick={onClose}>×</button>
        <span className="eyebrow">Safe-point handoff</span>
        <h2>Confirm custody</h2>
        <p>Enter the 6-digit code shown by the courier at {leg.safe_point_name}.</p>
        <form onSubmit={submit}>
          <label>
            6-digit one-time code
            <input required maxLength={6} pattern="\d{6}" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ textAlign: 'center', fontSize: '20px', letterSpacing: '4px' }} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" style={{ width: '100%', marginTop: '14px' }} type="submit" disabled={sending}>
            {sending ? 'Verifying custody…' : 'Confirm & update custody'}
          </button>
        </form>
      </section>
    </div>
  );
}

function DisputePageModal({ contractId, evidence, onClose, onSuccess }: { contractId: string; evidence: any; onClose: () => void; onSuccess: () => void }) {
  const [reason, setReason] = useState<'MISSING_PAGE' | 'ILLEGIBLE' | 'SOURCE_MISMATCH' | 'SPEC_NOT_MET'>('ILLEGIBLE');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await api(`/api/contracts/${contractId}/disputes`, {
        method: 'POST',
        body: JSON.stringify({ evidenceId: evidence.id, reason, note }),
      });
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-layer">
      <section className="modal compact-modal">
        <button className="close" onClick={onClose}>×</button>
        <span className="eyebrow">Page review</span>
        <h2>Dispute page {evidence.page_number}</h2>
        <p>Page-level review is required. General "reject all" is prohibited.</p>
        <form onSubmit={submit}>
          <label>
            Structured reason
            <select value={reason} onChange={(e: any) => setReason(e.target.value)}>
              <option value="MISSING_PAGE">Missing page</option>
              <option value="ILLEGIBLE">Illegible page</option>
              <option value="SOURCE_MISMATCH">Content differs from source</option>
              <option value="SPEC_NOT_MET">Contract specifications not met</option>
            </select>
          </label>
          <label>
            Concise note for writer and moderator
            <textarea required value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain the specific issue observed on this page" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="danger-link" style={{ width: '100%', marginTop: '14px', padding: '10px', background: '#ffe8e2', borderRadius: '6px' }} type="submit" disabled={sending}>
            {sending ? 'Filing dispute…' : 'File structured page dispute'}
          </button>
        </form>
      </section>
    </div>
  );
}

function DisputeResolutionModal({ dispute, onClose, onResolve }: { dispute: any; onClose: () => void; onResolve: (outcome: string, percent?: number, reason?: string, flagMisuse?: boolean) => void }) {
  const [outcome, setOutcome] = useState<'REQUESTER' | 'WRITER' | 'INCONCLUSIVE'>('INCONCLUSIVE');
  const [percent, setPercent] = useState(50);
  const [reason, setReason] = useState('');
  const [flagMisuse, setFlagMisuse] = useState(false);

  return (
    <div className="modal-layer">
      <section className="modal">
        <button className="close" onClick={onClose}>×</button>
        <span className="eyebrow">Operations dispute adjudication</span>
        <h2>Dispute on Page {dispute.page_number}</h2>

        <div className="comparison-box">
          <h4>Evidence Context & Comparison</h4>
          <p><strong>Contract:</strong> {dispute.title} ({dispute.page_count} pages, {money(dispute.reward)} Dime)</p>
          <p><strong>Criteria:</strong> {dispute.acceptance_criteria}</p>
          <p><strong>Dispute Reason:</strong> {statusLabel(dispute.reason)}</p>
          <p><strong>Requester Note:</strong> "{dispute.note || 'None'}"</p>
          <p><strong>Receipt Hash:</strong> <code>{dispute.receipt_hash}</code></p>
          <p><strong>Advisory OCR:</strong> {dispute.evidence_ocr_status} (Confidence: {dispute.evidence_ocr_confidence || 'N/A'})</p>
          {dispute.source_ocr_text && (
            <div>
              <p><strong>Source text excerpt:</strong></p>
              <pre>{dispute.source_ocr_text.slice(0, 300)}</pre>
            </div>
          )}
          {dispute.evidence_ocr_text && (
            <div>
              <p><strong>Submitted evidence OCR scan:</strong></p>
              <pre>{dispute.evidence_ocr_text.slice(0, 300)}</pre>
            </div>
          )}
        </div>

        <label>
          Adjudicated outcome:
          <select value={outcome} onChange={(e: any) => setOutcome(e.target.value)}>
            <option value="REQUESTER">Uphold for Requester (refund page allocation)</option>
            <option value="WRITER">Uphold for Writer (pay page allocation)</option>
            <option value="INCONCLUSIVE">Inconclusive evidence (split allocation)</option>
          </select>
        </label>

        {outcome === 'INCONCLUSIVE' && (
          <label>
            Completion percentage for disputed page:
            <input type="number" min="0" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
          </label>
        )}

        <label>
          Evidence-based moderator reason (required for audit trail):
          <textarea required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Document why this decision was reached based on the source and evidence photos" />
        </label>

        <label className="checkbox-label">
          <input type="checkbox" checked={flagMisuse} onChange={(e) => setFlagMisuse(e.target.checked)} />
          <span>Flag deliberate false dispute (records reliability penalty against requester)</span>
        </label>

        <button className="primary" style={{ width: '100%', marginTop: '14px' }} onClick={() => onResolve(outcome, percent, reason, flagMisuse)}>
          Resolve dispute & settle allocation
        </button>
      </section>
    </div>
  );
}

function ReportModal({ deliveryLegId, contractId, onClose, onSuccess }: { deliveryLegId?: string; contractId?: string; onClose: () => void; onSuccess: () => void }) {
  const [kind, setKind] = useState('SAFE_POINT_QUERY');
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ kind, detail, deliveryLegId, contractId }),
      });
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-layer">
      <section className="modal compact-modal">
        <button className="close" onClick={onClose}>×</button>
        <span className="eyebrow">Support & safety</span>
        <h2>Report an issue</h2>
        <form onSubmit={submit}>
          <label>
            Issue category
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="SAFE_POINT_QUERY">Safe point desk unstaffed / closed</option>
              <option value="DAMAGED_NOTEBOOK">Notebook damaged in transit</option>
              <option value="HANDOFF_FAILED">Handoff code not functioning</option>
              <option value="OTHER">Other safety or policy concern</option>
            </select>
          </label>
          <label>
            Details
            <textarea required value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Describe what happened" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" style={{ width: '100%', marginTop: '14px' }} type="submit" disabled={sending}>
            {sending ? 'Submitting…' : 'Submit report'}
          </button>
        </form>
      </section>
    </div>
  );
}

function AccessOnly() {
  return (
    <section className="panel access-only">
      <span>◒</span>
      <h2>Marketplace participation is for verified students.</h2>
      <p>This role is intentionally read-only and cannot request, accept, write, courier, fund, or transfer Dime.</p>
    </section>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

function navIcon(view: View) {
  return ({
    home: '⌂',
    opportunities: '⌕',
    create: '＋',
    work: '◫',
    wallet: '◒',
    inbox: '◌',
    guardian: '♡',
    admin: '✦',
    settings: '⚙',
  })[view];
}
