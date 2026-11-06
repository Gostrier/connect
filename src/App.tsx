import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bookmark,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Compass,
  DoorOpen,
  Filter,
  GraduationCap,
  Heart,
  LayoutDashboard,
  LogOut,
  Menu,
  MapPin,
  MoreHorizontal,
  MessageSquareText,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import './App.css';
import {
  api,
  categories,
  facilities,
  formatDate,
  formatTime,
  modeLabels,
  type Account,
  type CampusEvent,
  type NotificationItem,
} from './types';

type Screen =
  | 'landing'
  | 'dashboard'
  | 'discover'
  | 'details'
  | 'calendar'
  | 'recommendations'
  | 'notifications'
  | 'profile'
  | 'events'
  | 'create'
  | 'rooms'
  | 'conflicts'
  | 'applications'
  | 'admin-users'
  | 'analytics';

type Recommendation = { event: CampusEvent; score: number; reasons: string[] };
type AttendanceState = {
  session: { status: 'not_open' | 'open' | 'closed'; openedAt: string | null; closedAt: string | null };
  eventOngoing: boolean;
  canManage: boolean;
  canAttend: boolean;
  checkedInAt: string | null;
  radiusMeters: number;
  attendees: AttendanceAttendee[];
};
type AttendanceAttendee = { displayName: string; email: string; faculty: string | null; course: string | null; checkedInAt: string };
type ManagedRoom = { id: string; code: string; name: string; capacity: number; facilities: string[]; bufferMinutes: number; verified: boolean };
type ManagedUser = { id: string; email: string; displayName: string; role: string; faculty: string | null; course: string | null; organizerEnabled: number; adminEnabled: number; isActive: number; createdAt: string };
type RoomOption = {
  roomId: string;
  code: string;
  name: string;
  capacity: number;
  facilities: string[];
  missingFacilities: string[];
  capacityFitScore: number;
  conflict: { eventId: string; eventTitle: string; startAt: string; endAt: string } | null;
  eligible: boolean;
  reasons: string[];
};

const categoryColors: Record<string, string> = {
  'Academic & Research': 'lavender',
  'Career & Networking': 'blue',
  'Arts & Culture': 'rose',
  'Clubs & Social': 'amber',
  'Sports & Wellness': 'green',
  'Community Service': 'teal',
};

const categoryIcons: Record<string, string> = {
  'Academic & Research': '✦',
  'Career & Networking': '↗',
  'Arts & Culture': '◒',
  'Clubs & Social': '✳',
  'Sports & Wellness': '⌁',
  'Community Service': '♡',
};

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function datePartsInNairobi(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
  };
}

function dateKeyInNairobi(date: Date): string {
  const { year, month, day } = datePartsInNairobi(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function PageTitle({ eyebrow, title, description, action }: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function EventCard({ event, onOpen, onRegister, onSave, saved }: {
  event: CampusEvent;
  onOpen: () => void;
  onRegister?: () => void;
  onSave?: () => void;
  saved?: boolean;
}) {
  const color = categoryColors[event.category] ?? 'blue';
  return (
    <article className="event-card">
      <button className={`event-art ${color}`} onClick={onOpen} aria-label={`View ${event.title}`}>
        <span className="art-mark">{categoryIcons[event.category] ?? '✦'}</span>
        <span className="art-label">{event.isDemo ? 'DEMO EVENT' : modeLabels[event.deliveryMode]}</span>
        <span className="art-pattern" aria-hidden="true" />
      </button>
      <div className="event-card-body">
        <div className="event-card-meta">
          <span className={`category-pill ${color}`}>{event.category}</span>
          {event.isDemo && <span className="demo-tag">Sample</span>}
        </div>
        <button className="event-title-button" onClick={onOpen}>{event.title}</button>
        <div className="event-card-detail"><CalendarDays size={15} />{formatDate(event.startAt)}</div>
        <div className="event-card-detail"><Clock3 size={15} />{formatTime(event.startAt)} · {modeLabels[event.deliveryMode]}</div>
        <div className="event-card-detail"><DoorOpen size={15} />{event.roomName ?? (event.deliveryMode === 'online' ? 'Online event' : 'Venue to be confirmed')}</div>
        <div className="event-card-footer">
          <span className="seat-copy">{event.seatsAvailable > 0 ? `${event.seatsAvailable} seats left` : 'Waitlist open'}</span>
          <div className="card-actions">
            {onSave && <button className={`icon-button ${saved ? 'saved' : ''}`} onClick={onSave} aria-label={saved ? 'Remove saved event' : 'Save event'}><Bookmark size={17} fill={saved ? 'currentColor' : 'none'} /></button>}
            {onRegister && <button className="button button-small button-primary" onClick={event.currentRegistrationStatus ? onOpen : onRegister}>{event.currentRegistrationStatus === 'registered' ? 'Registered' : event.currentRegistrationStatus === 'waitlisted' ? `Waitlist #${event.currentWaitlistPosition ?? '—'}` : 'Register'}</button>}
            {!onRegister && <button className="text-button" onClick={onOpen}>Details <ArrowRight size={14} /></button>}
          </div>
        </div>
      </div>
    </article>
  );
}

function EmptyState({ icon, title, description, action }: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function AuthDialog({ initialMode, onClose, onSuccess }: {
  initialMode: 'login' | 'signup';
  onClose: () => void;
  onSuccess: (account: Account) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({ displayName: '', email: '', faculty: '', course: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/signup';
      const payload = mode === 'login'
        ? { email: form.email, password: form.password }
        : form;
      const result = await api<{ account: Account }>(path, { method: 'POST', body: JSON.stringify(payload) });
      onSuccess(result.account);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to continue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>
        <div className="brand-mark brand-mark-small"><GraduationCap size={22} /></div>
        <p className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'JOIN THE COMMUNITY'}</p>
        <h2 id="auth-title">{mode === 'login' ? 'Sign in to CampusConnect' : 'Create a student account'}</h2>
        <p className="muted">Presentation prototype only. Use a fictional <code>.test</code> email, never a real student identity.</p>
        <form className="stack-form" onSubmit={submit}>
          {mode === 'signup' && (
            <label>Full name
              <input required minLength={2} maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="e.g. Nia Wanjiku" autoComplete="name" />
            </label>
          )}
          <label>Email address
            <input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@campusconnect.test" autoComplete="email" />
          </label>
          {mode === 'signup' && <>
            <label>Faculty
              <input required maxLength={120} value={form.faculty} onChange={(event) => setForm({ ...form, faculty: event.target.value })} placeholder="e.g. School of Computing" autoComplete="organization-title" />
            </label>
            <label>Course
              <input required maxLength={120} value={form.course} onChange={(event) => setForm({ ...form, course: event.target.value })} placeholder="e.g. Information Technology" autoComplete="organization" />
            </label>
          </>}
          <label>Password
            <input required minLength={mode === 'signup' ? 10 : 1} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={mode === 'signup' ? 'At least 10 characters' : 'Enter your password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {mode === 'signup' && <label>Confirm password
            <input required minLength={10} type="password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} placeholder="Enter your password again" autoComplete="new-password" />
          </label>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={17} /></button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? 'New to CampusConnect?' : 'Already have a demo account?'}
          <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>
            {mode === 'login' ? 'Create account' : 'Sign in'}
          </button>
        </p>
        {mode === 'login' && <p className="field-note">Demo: student@campusconnect.test or organizer@campusconnect.test · CampusDemo!2026</p>}
      </section>
    </div>
  );
}

function LandingPage({ events, onAuth, onOpen }: {
  events: CampusEvent[];
  onAuth: (mode: 'login' | 'signup') => void;
  onOpen: (event: CampusEvent) => void;
}) {
  const featured = events.slice(0, 3);
  return (
    <>
      <section className="landing-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="pulse-dot" /> YOUR CAMPUS, IN THE KNOW</div>
          <h1>Make room for<br /><em>what matters.</em></h1>
          <p>Find your people, discover what’s happening, and turn a campus calendar into a community.</p>
          <div className="hero-actions">
            <button className="button button-light" onClick={() => onAuth('signup')}>Explore as a student <ArrowRight size={17} /></button>
            <button className="button button-outline-light" onClick={() => onAuth('login')}>Sign in</button>
          </div>
          <div className="hero-proof"><span className="avatar-stack"><i>NW</i><i>SK</i><i>KM</i></span><span>Find something worth showing up for</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
          <div className="hero-note note-top"><Sparkles size={16} /><span>Picked for your interests</span></div>
          <div className="hero-event-float">
            <div className="float-image"><span>✦</span><small>LEARN · BUILD · SHARE</small></div>
            <div className="float-content"><span className="category-pill lavender">Academic & Research</span><strong>AI for Everyone</strong><span>Friday · 10:00</span></div>
            <div className="float-going"><span className="green-dot" /> 72 students going</div>
          </div>
          <div className="hero-note note-bottom"><CalendarDays size={16} /><span>Your week, all in one place</span></div>
          <div className="hero-spark spark-a">✳</div><div className="hero-spark spark-b">✦</div>
        </div>
        <div className="hero-bottom-line"><span>DISCOVER</span><span>CONNECT</span><span>SHOW UP</span><ChevronDown size={16} /></div>
      </section>
      <main className="landing-main">
        <section className="section-block" id="events">
          <div className="section-heading">
            <div><p className="eyebrow">GOOD THINGS ARE HAPPENING</p><h2>Find your next thing.</h2><p>Small moments make a campus feel like yours.</p></div>
            <button className="button button-secondary" onClick={() => onAuth('signup')}>See all events <ArrowRight size={16} /></button>
          </div>
          <div className="event-grid landing-event-grid">
            {featured.length ? featured.map((event) => <EventCard key={event.id} event={event} onOpen={() => onOpen(event)} />) : <EmptyState icon={<CalendarDays />} title="The calendar is warming up" description="Sample events will appear here when the demo is ready." />}
          </div>
        </section>
        <section className="benefit-section" id="benefits">
          <div className="benefit-intro"><p className="eyebrow">CAMPUS, CONNECTED</p><h2>Less searching.<br /><em>More showing up.</em></h2><p>One calm place to discover events, save your seat, and bring your campus plans together.</p></div>
          <div className="benefit-list">
            <div><span className="benefit-icon"><Compass size={21} /></span><div><h3>Find your kind of thing</h3><p>Recommendations get clearer as you explore your interests and campus community.</p></div><b>01</b></div>
            <div><span className="benefit-icon"><CalendarCheckIcon /></span><div><h3>Your plans, in one view</h3><p>See what’s coming up, keep your place, and get a gentle nudge when it matters.</p></div><b>02</b></div>
            <div><span className="benefit-icon"><DoorOpen size={21} /></span><div><h3>Better rooms, fewer clashes</h3><p>Give organizers a clear view of suitable spaces and booking conflicts.</p></div><b>03</b></div>
          </div>
        </section>
        <section className="bottom-cta"><div><p className="eyebrow">YOUR CAMPUS IS FULL OF POSSIBILITIES</p><h2>There’s a place for you here.</h2></div><button className="button button-light" onClick={() => onAuth('signup')}>Create your account <ArrowRight size={16} /></button></section>
      </main>
      <footer className="public-footer"><Brand /><span>CampusConnect · A university project prototype</span><span>Built for belonging.</span></footer>
    </>
  );
}

function CalendarCheckIcon() {
  return <CalendarPlus size={21} />;
}

function StudentDashboard({ account, events, recommendations, onNavigate, onOpen, onRegister, savedIds, onSave }: {
  account: Account;
  events: CampusEvent[];
  recommendations: Recommendation[];
  onNavigate: (screen: Screen) => void;
  onOpen: (event: CampusEvent) => void;
  onRegister: (event: CampusEvent) => void;
  savedIds: string[];
  onSave: (eventId: string) => void;
}) {
  const [todayIso] = useState(() => new Date().toISOString());
  const upcoming = events.filter((event) => event.currentRegistrationStatus === 'registered').slice(0, 3);
  const latest = events.slice(0, 3);
  return (
    <div className="page-stack">
      <section className="welcome-banner">
        <div><p className="eyebrow light-eyebrow">{formatDate(todayIso, { weekday: 'long', month: 'long', day: '2-digit' }).toUpperCase()}</p><h1>Good afternoon, {account.displayName.split(' ')[0]} <span>✦</span></h1><p>Your next campus moment is closer than you think.</p></div>
        <div className="welcome-side"><div className="welcome-date"><CalendarDays size={18} /><span>{formatDate(todayIso, { weekday: 'long', month: 'long', day: 'numeric' })}</span></div><div className="welcome-decoration">✳</div></div>
      </section>
      <section className="dashboard-stats">
        <StatCard label="Registered events" value={String(upcoming.length).padStart(2, '0')} detail="On your calendar" icon={<CalendarDays />} tone="blue" />
        <StatCard label="Saved for later" value={String(savedIds.length).padStart(2, '0')} detail="Ideas worth keeping" icon={<Bookmark />} tone="lavender" />
        <StatCard label="For you" value={String(recommendations.length).padStart(2, '0')} detail="Fresh recommendations" icon={<Sparkles />} tone="amber" />
      </section>
      <section className="section-block compact-section">
        <div className="section-heading"><div><p className="eyebrow">A LITTLE SOMETHING FOR YOU</p><h2>Picked for your week</h2></div><button className="text-button" onClick={() => onNavigate('recommendations')}>All recommendations <ArrowRight size={15} /></button></div>
        <div className="event-grid">
          {recommendations.slice(0, 3).map((item) => <RecommendationCard key={item.event.id} item={item} onOpen={() => onOpen(item.event)} onRegister={() => onRegister(item.event)} onSave={() => onSave(item.event.id)} saved={savedIds.includes(item.event.id)} />)}
          {!recommendations.length && <EmptyState icon={<Sparkles />} title="Let’s find your interests" description="Add a few interests to your profile and your recommendations will get more personal." action={<button className="button button-secondary" onClick={() => onNavigate('profile')}>Update profile</button>} />}
        </div>
      </section>
      <section className="two-column-section">
        <div className="panel upcoming-panel">
          <div className="panel-heading"><div><p className="eyebrow">COMING UP</p><h2>Your next events</h2></div><button className="icon-button" onClick={() => onNavigate('calendar')} aria-label="Open calendar"><ArrowRight size={18} /></button></div>
          {upcoming.length ? upcoming.map((event) => <div className="upcoming-row" key={event.id} onClick={() => onOpen(event)} role="button" tabIndex={0}><div className="date-tile"><b>{new Intl.DateTimeFormat('en-KE', { day: '2-digit', timeZone: 'Africa/Nairobi' }).format(new Date(event.startAt))}</b><span>{new Intl.DateTimeFormat('en-KE', { month: 'short', timeZone: 'Africa/Nairobi' }).format(new Date(event.startAt))}</span></div><div className="upcoming-copy"><strong>{event.title}</strong><span>{formatTime(event.startAt)} · {event.roomName ?? 'Online'}</span></div><ChevronRight size={17} /></div>) : <div className="panel-empty"><CalendarDays size={22} /><span>Your calendar is ready for its first event.</span><button className="text-button" onClick={() => onNavigate('discover')}>Explore events</button></div>}
        </div>
        <div className="panel quick-panel">
          <div className="panel-heading"><div><p className="eyebrow">MAKE IT YOURS</p><h2>Quick actions</h2></div><Sparkles size={19} className="accent-icon" /></div>
          <button className="quick-action" onClick={() => onNavigate('discover')}><span className="quick-icon blue"><Search size={18} /></span><span><b>Explore events</b><small>Find something new</small></span><ArrowUpRight size={16} /></button>
          <button className="quick-action" onClick={() => onNavigate('calendar')}><span className="quick-icon lavender"><CalendarDays size={18} /></span><span><b>Open my calendar</b><small>See your upcoming plans</small></span><ArrowUpRight size={16} /></button>
          <button className="quick-action" onClick={() => onNavigate('profile')}><span className="quick-icon amber"><Heart size={18} /></span><span><b>Update interests</b><small>Make recommendations yours</small></span><ArrowUpRight size={16} /></button>
        </div>
      </section>
      <section className="section-block compact-section">
        <div className="section-heading"><div><p className="eyebrow">JUST ADDED</p><h2>New around campus</h2></div><button className="text-button" onClick={() => onNavigate('discover')}>Browse all <ArrowRight size={15} /></button></div>
        <div className="event-grid">{latest.map((event) => <EventCard key={event.id} event={event} onOpen={() => onOpen(event)} onRegister={() => onRegister(event)} onSave={() => onSave(event.id)} saved={savedIds.includes(event.id)} />)}</div>
      </section>
    </div>
  );
}

function StatCard({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: ReactNode; tone: string }) {
  return <div className="stat-card"><span className={`stat-icon ${tone}`}>{icon}</span><div><span className="stat-label">{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function RecommendationCard({ item, onOpen, onRegister, onSave, saved }: {
  item: Recommendation;
  onOpen: () => void;
  onRegister: () => void;
  onSave: () => void;
  saved: boolean;
}) {
  return (
    <div className="recommendation-card">
      <div className={`recommendation-art ${categoryColors[item.event.category] ?? 'blue'}`}><span>{categoryIcons[item.event.category] ?? '✦'}</span><small>FOR YOU</small></div>
      <div className="recommendation-card-body">
        <div className="recommendation-score"><Sparkles size={14} />{item.score}% match</div>
        <button className="event-title-button" onClick={onOpen}>{item.event.title}</button>
        <span className="card-subtitle">{formatDate(item.event.startAt)} · {formatTime(item.event.startAt)}</span>
        <ul className="reason-list">{item.reasons.slice(0, 2).map((reason) => <li key={reason}><Check size={13} />{reason}</li>)}</ul>
        <div className="recommendation-actions"><button className="button button-small button-primary" onClick={onRegister}>Register</button><button className={`icon-button ${saved ? 'saved' : ''}`} onClick={onSave} aria-label={saved ? 'Remove saved event' : 'Save event'}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'} /></button></div>
      </div>
    </div>
  );
}

function OrganizerDashboard({ events, onNavigate, onOpen }: {
  events: CampusEvent[];
  onNavigate: (screen: Screen) => void;
  onOpen: (event: CampusEvent) => void;
}) {
  const upcoming = events.filter((event) => event.status === 'published').slice(0, 4);
  const registrations = events.reduce((sum, event) => sum + event.registeredCount, 0);
  return (
    <div className="page-stack">
      <section className="organizer-welcome">
        <div><p className="eyebrow light-eyebrow">ORGANIZER WORKSPACE</p><h1>Make good things happen.</h1><p>Plan a thoughtful event. CampusConnect can help with the room and the follow-through.</p></div>
        <button className="button button-light" onClick={() => onNavigate('create')}><Plus size={17} /> Create an event</button>
        <div className="organizer-decoration">✳</div>
      </section>
      <section className="dashboard-stats">
        <StatCard label="Total events" value={String(events.length).padStart(2, '0')} detail="Across campus" icon={<CalendarDays />} tone="blue" />
        <StatCard label="Upcoming" value={String(upcoming.length).padStart(2, '0')} detail="Published events" icon={<Clock3 />} tone="lavender" />
        <StatCard label="Registered students" value={String(registrations).padStart(2, '0')} detail="Confirmed seats" icon={<Users />} tone="green" />
      </section>
      <section className="organizer-shortcuts">
        <button onClick={() => onNavigate('create')}><span className="shortcut-icon blue"><Plus size={20} /></span><span><b>Create event</b><small>Share something with campus</small></span><ArrowRight size={17} /></button>
        <button onClick={() => onNavigate('events')}><span className="shortcut-icon lavender"><CalendarDays size={20} /></span><span><b>Manage events</b><small>Edit details and registrations</small></span><ArrowRight size={17} /></button>
        <button onClick={() => onNavigate('rooms')}><span className="shortcut-icon amber"><DoorOpen size={20} /></span><span><b>Allocate a room</b><small>Find a suitable space</small></span><ArrowRight size={17} /></button>
        <button onClick={() => onNavigate('analytics')}><span className="shortcut-icon green"><ArrowUpRight size={20} /></span><span><b>View reports</b><small>Understand the turnout</small></span><ArrowRight size={17} /></button>
      </section>
      <section className="section-block compact-section">
        <div className="section-heading"><div><p className="eyebrow">YOUR CAMPUS CALENDAR</p><h2>Events to keep an eye on</h2></div><button className="text-button" onClick={() => onNavigate('events')}>Manage all <ArrowRight size={15} /></button></div>
        <div className="event-grid">{upcoming.slice(0, 3).map((event) => <EventCard key={event.id} event={event} onOpen={() => onOpen(event)} />)}</div>
      </section>
    </div>
  );
}

function DiscoveryPage({ events, onOpen, onRegister, onSave, savedIds }: {
  events: CampusEvent[];
  onOpen: (event: CampusEvent) => void;
  onRegister: (event: CampusEvent) => void;
  onSave: (eventId: string) => void;
  savedIds: string[];
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [faculty, setFaculty] = useState('');
  const [mode, setMode] = useState('');
  const [venue, setVenue] = useState('');
  const [date, setDate] = useState('');
  const faculties = useMemo(() => [...new Set(events.map((event) => event.faculty))].sort(), [events]);
  const filtered = events.filter((event) => {
    const text = `${event.title} ${event.description} ${event.category} ${event.faculty} ${event.roomName ?? ''}`.toLowerCase();
    return (!search || text.includes(search.toLowerCase()))
      && (!category || event.category === category)
      && (!faculty || event.faculty === faculty)
      && (!mode || event.deliveryMode === mode)
      && (!venue || (event.roomName ?? 'Online').toLowerCase().includes(venue.toLowerCase()))
      && (!date || event.startAt.slice(0, 10) === date);
  });
  const reset = () => { setSearch(''); setCategory(''); setFaculty(''); setMode(''); setVenue(''); setDate(''); };
  return (
    <div className="page-stack">
      <PageTitle eyebrow="DISCOVER YOUR CAMPUS" title="Find your next thing." description="A workshop, a new idea, a familiar face. It’s all happening somewhere." />
      <div className="discover-search"><Search size={20} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search events, topics, or people" aria-label="Search events" /><kbd>⌘ K</kbd></div>
      <section className="filter-panel">
        <div className="filter-head"><span><Filter size={16} /> Refine your search</span><button className="text-button" onClick={reset}>Clear all</button></div>
        <div className="filter-grid">
          <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Faculty<select value={faculty} onChange={(event) => setFaculty(event.target.value)}><option value="">All faculties</option>{faculties.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label>Event type<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">All types</option><option value="in_person">In-person</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label>
          <label>Venue<input value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Room or online" /></label>
        </div>
      </section>
      <div className="result-heading"><span><b>{filtered.length}</b> {filtered.length === 1 ? 'event' : 'events'} to explore</span><span className="sort-label">Soonest first <ChevronDown size={15} /></span></div>
      {filtered.length ? <div className="event-grid">{filtered.map((event) => <EventCard key={event.id} event={event} onOpen={() => onOpen(event)} onRegister={() => onRegister(event)} onSave={() => onSave(event.id)} saved={savedIds.includes(event.id)} />)}</div> : <EmptyState icon={<Search />} title="No events found" description="Try a different search or clear some filters." action={<button className="button button-secondary" onClick={reset}>Clear filters</button>} />}
    </div>
  );
}

function EventDetails({ event, account, saved, onSave, onRegister, onCancelRegistration, onBack, onEdit, organizerWorkspace = false }: {
  event: CampusEvent;
  account: Account | null;
  saved: boolean;
  onSave: () => void;
  onRegister: () => void;
  onCancelRegistration: () => void;
  onBack: () => void;
  onEdit: () => void;
  organizerWorkspace?: boolean;
}) {
  const color = categoryColors[event.category] ?? 'blue';
  const share = async () => {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: event.title, text: event.description, url });
    else await navigator.clipboard.writeText(url);
  };
  return (
    <div className="page-stack">
      <button className="back-link" onClick={onBack}><ChevronLeft size={17} /> Back to events</button>
      <div className={`details-banner ${color}`}><div className="details-banner-mark">{categoryIcons[event.category] ?? '✦'}</div><span className="details-banner-label">{event.isDemo ? 'FICTIONAL SAMPLE EVENT' : event.category}</span><span className="details-banner-shape shape-one" /><span className="details-banner-shape shape-two" /></div>
      <div className="details-layout">
        <main className="details-main">
          <div className="details-heading"><span className={`category-pill ${color}`}>{event.category}</span>{event.isDemo && <span className="demo-tag">Fictional demo event</span>}</div>
          <h1>{event.title}</h1>
          <p className="details-description">{event.description}</p>
          <div className="details-facts">
            <div><CalendarDays size={19} /><span><b>{formatDate(event.startAt, { weekday: 'long', year: 'numeric' })}</b><small>Event date</small></span></div>
            <div><Clock3 size={19} /><span><b>{formatTime(event.startAt)} – {formatTime(event.endAt)}</b><small>East Africa Time</small></span></div>
            <div><DoorOpen size={19} /><span><b>{event.roomName ?? (event.deliveryMode === 'online' ? 'Online event' : 'Venue to be confirmed')}</b><small>{modeLabels[event.deliveryMode]} · {event.faculty}</small></span></div>
            <div><Users size={19} /><span><b>{event.seatsAvailable > 0 ? `${event.seatsAvailable} seats available` : 'Waitlist open'}</b><small>{event.registeredCount} registered of {event.registrationCapacity}</small></span></div>
          </div>
          {event.meetingUrl && <a className="meeting-link" href={event.meetingUrl} target="_blank" rel="noreferrer">Open event link <ArrowUpRight size={15} /></a>}
          <div className="organizer-card"><span className="avatar">{initials(event.organizerName)}</span><div><small>Organized by</small><strong>{event.organizerName}</strong></div><ShieldCheck size={18} /></div>
          <section className="details-about"><h2>About this event</h2><p>{event.description}</p><p className="muted">Registration closes {formatDate(event.registrationClosesAt, { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.</p></section>
          {account && event.deliveryMode !== 'online' && <AttendancePanel eventId={event.id} role={account.role} />}
        </main>
        <aside className="registration-card">
          <span className="eyebrow">SAVE YOUR SEAT</span><strong>{event.seatsAvailable > 0 ? `${event.seatsAvailable} spots left` : 'Join the waitlist'}</strong>
          <p>Free to attend. Your registration can be cancelled any time before the event starts.</p>
          {account?.role === 'student' && event.currentRegistrationStatus === 'registered'
            ? <button className="button button-secondary button-wide" onClick={onCancelRegistration}>Cancel registration</button>
            : account?.role === 'student' && event.currentRegistrationStatus === 'waitlisted'
              ? <><div className="waitlist-position">You’re <b>#{event.currentWaitlistPosition ?? '—'}</b> in the first-in, first-out queue.</div><button className="button button-waitlist button-wide" onClick={onCancelRegistration}>Leave waitlist</button></>
              : account?.role === 'student'
                ? <button className="button button-primary button-wide" onClick={onRegister}>{event.seatsAvailable > 0 ? 'Register for free' : 'Join waitlist'} <ArrowRight size={16} /></button>
                : <p className="field-note">Sign in as a Student to register.</p>}
          <div className="side-actions"><button className={`text-button ${saved ? 'saved-text' : ''}`} onClick={onSave}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Saved' : 'Save event'}</button><button className="text-button" onClick={() => void share()}><Share2 size={15} />Share</button></div>
          {organizerWorkspace && <button className="button button-secondary button-wide" onClick={onEdit}>Edit event</button>}
        </aside>
      </div>
    </div>
  );
}

function getCurrentLocation(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support location access.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
      (error) => reject(new Error(error.code === error.PERMISSION_DENIED
        ? 'Allow location access in your browser to continue.'
        : error.code === error.TIMEOUT
          ? 'Could not get your location in time. Try again.'
          : 'Your location is unavailable. Check your device settings and try again.')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  });
}

function AttendancePanel({ eventId, role }: { eventId: string; role: Account['role'] }) {
  const [attendance, setAttendance] = useState<AttendanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const result = await api<AttendanceState>(`/events/${eventId}/attendance`);
    setAttendance(result);
  }, [eventId]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const result = await api<AttendanceState>(`/events/${eventId}/attendance`);
        if (mounted) setAttendance(result);
      } catch (reason) {
        if (mounted) setError(reason instanceof Error ? reason.message : 'Attendance status could not be loaded.');
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [eventId]);

  const act = async (action: 'open' | 'close' | 'check-in') => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const location = action === 'close' ? undefined : await getCurrentLocation();
      await api(`/events/${eventId}/attendance/${action}`, {
        method: 'POST',
        ...(location ? { body: JSON.stringify(location) } : {}),
      });
      setMessage(action === 'open' ? 'Attendance is open. Students can check in at this location.' : action === 'close' ? 'Attendance is closed.' : 'Your attendance has been marked.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Attendance could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const organizerView = attendance?.canManage ?? role === 'organizer';
  if (role === 'organizer' && attendance && !attendance.canManage) return null;
  return (
    <section className="attendance-panel">
      <div className="attendance-panel-heading"><span className="attendance-icon"><MapPin size={18} /></span><div><h2>Event attendance</h2><p>Location check-in within {attendance?.radiusMeters ?? 100} m</p></div></div>
      {loading ? <p className="field-note">Loading attendance status…</p> : attendance && (
        <>
          {organizerView && <p className="attendance-description">Open attendance while you are at the event. The location at opening becomes the check-in point.</p>}
          {!organizerView && !attendance.canAttend && <p className="attendance-description">Check-in is available to students with a confirmed registration.</p>}
          {organizerView
            ? attendance.session.status === 'open'
              ? <div className="attendance-actions"><span className="attendance-live"><i /> Attendance is open</span><button className="button button-secondary button-small" disabled={busy} onClick={() => void act('close')}>{busy ? 'Closing…' : 'Close attendance'}</button></div>
              : attendance.session.status === 'closed'
                ? <div className="attendance-success"><CheckCircle2 size={17} /> Attendance is closed.</div>
                : <button className="button button-primary button-small" disabled={busy || !attendance.eventOngoing} onClick={() => void act('open')}>{busy ? 'Getting location…' : attendance.eventOngoing ? 'Open attendance at this location' : 'Available during the event'}</button>
            : attendance.checkedInAt
            ? <div className="attendance-success"><CheckCircle2 size={17} /> Attendance marked at {formatTime(attendance.checkedInAt)}.</div>
              : attendance.session.status === 'open' && attendance.eventOngoing && attendance.canAttend
                ? <button className="button button-primary button-small" disabled={busy} onClick={() => void act('check-in')}>{busy ? 'Checking location…' : 'Mark my attendance'}</button>
                : <p className="field-note">{attendance.session.status === 'closed' ? 'The organizer has closed attendance.' : attendance.session.status === 'not_open' ? 'The organizer has not opened attendance yet.' : attendance.eventOngoing ? 'A confirmed registration is required to check in.' : 'Check-in is available while the event is ongoing.'}</p>}
          {attendance.canManage && attendance.attendees.length > 0 && <div className="attendance-roster">
            <h3>Checked-in students <span>{attendance.attendees.length}</span></h3>
            {attendance.attendees.map((student) => <div className="attendance-student" key={student.email}>
              <span className="attendance-student-avatar">{initials(student.displayName)}</span>
              <div><b>{student.displayName}</b><small>{student.email}</small><small>{[student.course, student.faculty].filter(Boolean).join(' · ') || 'Student'}</small></div>
              <time>{formatTime(student.checkedInAt)}</time>
            </div>)}
          </div>}
        </>
      )}
      {message && <p className="attendance-feedback" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function CalendarPage({ events, onOpen }: { events: CampusEvent[]; onOpen: (event: CampusEvent) => void }) {
  const [view, setView] = useState<'month' | 'week'>('month');
  const [today] = useState(() => dateKeyInNairobi(new Date()));
  const [cursor, setCursor] = useState(() => {
    const { year, month } = datePartsInNairobi(new Date());
    return new Date(year, month - 1, 1);
  });
  const selected = events.filter((event) => event.currentRegistrationStatus === 'registered');
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const firstDay = new Date(monthStart);
  firstDay.setDate(monthStart.getDate() - ((monthStart.getDay() + 6) % 7));
  const days = Array.from({ length: view === 'month' ? 42 : 7 }, (_, index) => {
    const date = new Date(firstDay);
    if (view === 'week') {
      const start = new Date(cursor);
      start.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
      date.setTime(start.getTime());
      date.setDate(start.getDate() + index);
    } else date.setDate(firstDay.getDate() + index);
    return date;
  });
  const dayEvents = (date: Date) => selected.filter((event) => {
    return dateKeyInNairobi(new Date(event.startAt)) === dateKey(date);
  });
  const changeMonth = (amount: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + amount, 1));
  const monthLabel = new Intl.DateTimeFormat('en-KE', { month: 'long' }).format(cursor);
  return (
    <div className="page-stack">
      <PageTitle eyebrow="YOUR CAMPUS PLANS" title="Student calendar" description="Your registered events and the moments you’ve saved a seat for." action={<button className="button button-secondary"><CalendarPlus size={17} /> Add to calendar</button>} />
      <div className="calendar-toolbar"><div className="month-switch"><button className="icon-button" onClick={() => changeMonth(-1)} aria-label="Previous period"><ChevronLeft size={18} /></button><strong>{monthLabel} {cursor.getFullYear()}</strong><button className="icon-button" onClick={() => changeMonth(1)} aria-label="Next period"><ChevronRight size={18} /></button></div><div className="segmented-control"><button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>Month</button><button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>Week</button></div></div>
      <div className={`calendar-grid ${view === 'week' ? 'week-view' : ''}`}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
        {days.map((day) => {
          const items = dayEvents(day);
          const inMonth = day.getMonth() === cursor.getMonth();
          return <div className={`calendar-day ${inMonth ? '' : 'outside-month'}`} key={day.toISOString()}><span className={`calendar-day-number ${dateKey(day) === today ? 'today' : ''}`}>{day.getDate()}</span>{items.slice(0, 2).map((event) => <button key={event.id} className="calendar-event" onClick={() => onOpen(event)}>{formatTime(event.startAt)} {event.title}</button>)}{items.length > 2 && <small className="more-events">+{items.length - 2} more</small>}</div>;
        })}
      </div>
      <section className="section-block compact-section"><div className="section-heading"><div><p className="eyebrow">DON’T FORGET</p><h2>Upcoming reminders</h2></div></div><div className="reminder-row"><span className="reminder-icon"><Bell size={17} /></span><span><b>24-hour reminder</b><small>We’ll nudge you the day before an event.</small></span><span className="status-pill status-on">On</span></div></section>
    </div>
  );
}

function NotificationsPage({ notifications, onRead }: { notifications: NotificationItem[]; onRead: (item: NotificationItem) => void }) {
  const unread = notifications.filter((item) => !item.readAt);
  return (
    <div className="page-stack">
      <PageTitle eyebrow="STAY IN THE LOOP" title="Notifications" description="The useful things, right when you need them." action={<span className="count-pill">{unread.length} unread</span>} />
      <div className="notification-preferences"><div className="preference-icon"><Bell size={19} /></div><div><strong>In-app updates are on</strong><p>Push and SMS delivery are not configured in this presentation build.</p></div><span className="status-pill status-on">Active</span></div>
      <div className="notification-list">
        {notifications.map((item) => <button className={`notification-item ${item.readAt ? '' : 'unread'}`} key={item.id} onClick={() => onRead(item)}><span className={`notification-icon ${item.kind}`}><NotificationIcon kind={item.kind} /></span><span className="notification-copy"><b>{item.message}</b><small>{formatDate(item.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>{!item.readAt && <span className="unread-dot" />}</button>)}
        {!notifications.length && <EmptyState icon={<Bell />} title="You’re all caught up" description="Registration confirmations and event reminders will show up here." />}
      </div>
    </div>
  );
}

function NotificationIcon({ kind }: { kind: string }) {
  if (kind === 'event_changes') return <MessageSquareText size={18} />;
  if (kind === 'recommendation') return <Sparkles size={18} />;
  return <CheckCircle2 size={18} />;
}

function RecommendationsPage({ items, onOpen, onRegister }: {
  items: Recommendation[];
  onOpen: (event: CampusEvent) => void;
  onRegister: (event: CampusEvent) => void;
}) {
  return (
    <div className="page-stack">
      <PageTitle eyebrow="A LITTLE MORE YOU" title="Recommended for you" description="Every score is built from four simple signals, with the reasons shown right beside it." />
      <div className="algorithm-note"><Sparkles size={19} /><span><b>How the match works</b><small>Interests · Faculty or course · Club memberships · Previous attendance. Each contributes equally to the score.</small></span><span className="transparent-badge"><ShieldCheck size={14} /> Transparent</span></div>
      {items.length ? <div className="recommendation-list">{items.map((item) => <article className="recommendation-row" key={item.event.id}><div className={`recommendation-thumb ${categoryColors[item.event.category] ?? 'blue'}`}><span>{categoryIcons[item.event.category] ?? '✦'}</span></div><div className="recommendation-row-copy"><span className={`category-pill ${categoryColors[item.event.category] ?? 'blue'}`}>{item.event.category}</span><button className="event-title-button" onClick={() => onOpen(item.event)}>{item.event.title}</button><small>{formatDate(item.event.startAt)} · {formatTime(item.event.startAt)} · {item.event.faculty}</small><div className="reason-chips">{item.reasons.map((reason) => <span key={reason}><Check size={12} />{reason}</span>)}</div></div><div className="score-meter"><div className="score-ring" style={{ '--score': `${item.score}%` } as React.CSSProperties}><span>{item.score}<small>%</small></span></div><small>match</small></div><button className="button button-primary button-small" onClick={() => onRegister(item.event)}>Register</button></article>)}</div> : <EmptyState icon={<Sparkles />} title="No new recommendations yet" description="Try updating your interests or explore the full event list." />}
    </div>
  );
}

function ProfilePage({ account, onUpdate }: { account: Account; onUpdate: (patch: Record<string, unknown>) => Promise<void> }) {
  const [interests, setInterests] = useState(account.interests);
  const [clubs, setClubs] = useState(account.clubs);
  const [faculty, setFaculty] = useState(account.faculty ?? '');
  const [course, setCourse] = useState(account.course ?? '');
  const [personalization, setPersonalization] = useState(account.personalizationEnabled);
  const [notificationPreferences, setNotificationPreferences] = useState(account.inAppPreferences);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const toggle = (list: string[], setList: (next: string[]) => void, value: string) => setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveError('');
    try {
      await onUpdate({
        faculty: faculty || null,
        course: course || null,
        interests,
        clubs,
        personalizationEnabled: personalization,
        inAppPreferences: notificationPreferences,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'Profile preferences could not be saved.');
    }
  };
  return (
    <div className="page-stack">
      <PageTitle eyebrow="YOUR CAMPUS, YOUR WAY" title="Profile & interests" description="Keep the details that make recommendations useful. You can leave any field blank." />
      <form className="profile-layout" onSubmit={(event) => void submit(event)}>
        <section className="panel profile-card">
          <div className="profile-person"><span className="profile-avatar">{initials(account.displayName)}</span><div><h2>{account.displayName}</h2><span>{account.email}</span></div><span className="role-pill">{account.adminEnabled ? 'Administrator' : account.organizerEnabled ? 'Student · Organizer' : account.role}</span></div>
          <label>Faculty or school<input value={faculty} onChange={(event) => setFaculty(event.target.value)} placeholder="Optional" /></label>
          <label>Course of study<input value={course} onChange={(event) => setCourse(event.target.value)} placeholder="Optional" /></label>
          <fieldset><legend>What are you curious about?</legend><div className="chip-select-list">{categories.map((item) => <button type="button" className={`select-chip ${interests.includes(item) ? 'selected' : ''}`} key={item} onClick={() => toggle(interests, setInterests, item)}>{interests.includes(item) && <Check size={13} />}{item}</button>)}</div></fieldset>
          <label>Clubs and communities, separated by commas<input value={clubs.join(', ')} onChange={(event) => setClubs(event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} placeholder="Optional" /></label>
          <div className="toggle-row"><span><b>Personalized recommendations</b><small>Use these profile details to explain event matches.</small></span><button type="button" className={`toggle ${personalization ? 'on' : ''}`} role="switch" aria-checked={personalization} onClick={() => setPersonalization(!personalization)}><i /></button></div>
          <div className="preference-group"><div><b>In-app notifications</b><small>Essential updates are on by default. Mute categories any time.</small></div>{[
            ['registration', 'Registration confirmations'],
            ['event_reminder', '24-hour event reminders'],
            ['registration_close', 'Registration closing alerts'],
            ['event_changes', 'Event changes and cancellations'],
          ].map(([key, label]) => {
            const enabled = notificationPreferences[key] !== false;
            return <div className="toggle-row preference-toggle" key={key}><span><b>{label}</b></span><button type="button" className={`toggle ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} onClick={() => setNotificationPreferences((current) => ({ ...current, [key]: !enabled }))}><i /></button></div>;
          })}</div>
          {saveError && <div className="form-error" role="alert">{saveError}</div>}
          <button className="button button-primary" type="submit">{saved ? <><Check size={16} /> Saved</> : 'Save preferences'}</button>
        </section>
        <aside className="privacy-card"><span className="privacy-icon"><ShieldCheck size={22} /></span><h3>Your details stay in your hands.</h3><p>Profile fields are optional. Recommendation inputs are used only to personalize event matches and can be cleared or switched off.</p><div className="privacy-note"><Check size={15} /> Demo accounts use fictional information only</div></aside>
      </form>
    </div>
  );
}

function OrganizerEventsPage({ events, onOpen, onNavigate, onPublish, onCancel }: {
  events: CampusEvent[];
  onOpen: (event: CampusEvent) => void;
  onNavigate: (screen: Screen) => void;
  onPublish: (event: CampusEvent) => void;
  onCancel: (event: CampusEvent) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'published' | 'draft'>('all');
  const visible = events.filter((event) => event.status !== 'cancelled' && (filter === 'all' || event.status === filter));
  return (
    <div className="page-stack">
      <PageTitle eyebrow="ORGANIZER WORKSPACE" title="Manage events" description="Keep the campus calendar clear, current, and easy to trust." action={<button className="button button-primary" onClick={() => onNavigate('create')}><Plus size={16} /> Create event</button>} />
      <div className="segmented-control table-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All events</button><button className={filter === 'published' ? 'active' : ''} onClick={() => setFilter('published')}>Published</button><button className={filter === 'draft' ? 'active' : ''} onClick={() => setFilter('draft')}>Drafts</button></div>
      {visible.length ? <div className="manage-event-list">{visible.map((event) => <article className="manage-event-row" key={event.id}><div className={`manage-event-mark ${categoryColors[event.category] ?? 'blue'}`}>{categoryIcons[event.category] ?? '✦'}</div><div className="manage-event-copy"><button className="event-title-button" onClick={() => onOpen(event)}>{event.title}</button><span>{formatDate(event.startAt)} · {modeLabels[event.deliveryMode]} · {event.registeredCount} registered · {event.waitlistCount} waiting</span></div><span className={`status-pill status-${event.status}`}>{event.status}</span><div className="manage-event-actions">{event.status === 'draft' && <button className="button button-small button-secondary" onClick={() => onPublish(event)}>Publish</button>}<button className="button button-small button-secondary" onClick={() => onOpen(event)}>Edit</button><button className="icon-button danger-icon" onClick={() => onCancel(event)} aria-label={`Cancel ${event.title}`}><X size={17} /></button></div></article>)}</div> : <EmptyState icon={<CalendarDays />} title="No events in this view" description="Create an event to start building the campus calendar." action={<button className="button button-primary" onClick={() => onNavigate('create')}>Create event</button>} />}
    </div>
  );
}

type OrganizerApplication = {
  id: string;
  clubName: string;
  position: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  applicantName?: string;
  applicantEmail?: string;
  faculty?: string | null;
  course?: string | null;
};

function OrganizerApplicationsPage({ account, canReview, onAccountUpdated }: {
  account: Account;
  canReview: boolean;
  onAccountUpdated: (account: Account) => void;
}) {
  const [mine, setMine] = useState<OrganizerApplication[]>([]);
  const [queue, setQueue] = useState<OrganizerApplication[]>([]);
  const [clubName, setClubName] = useState(account.clubs[0] ?? '');
  const [position, setPosition] = useState('');
  const [reason, setReason] = useState('');
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [ownResult, accountResult] = await Promise.all([
      api<{ applications: OrganizerApplication[] }>('/organizer-applications/mine'),
      api<{ account: Account }>('/auth/me'),
    ]);
    setMine(ownResult.applications);
    onAccountUpdated(accountResult.account);
    if (canReview) {
      const result = await api<{ applications: OrganizerApplication[] }>('/organizer-applications/review');
      setQueue(result.applications);
    }
  }, [canReview, onAccountUpdated]);
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Applications could not be loaded.')); }, [refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/organizer-applications', { method: 'POST', body: JSON.stringify({ clubName, position, reason }) });
      setPosition('');
      setReason('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The application could not be submitted.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: string) => {
    setError('');
    try {
      await api(`/organizer-applications/${id}/withdraw`, { method: 'POST' });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The application could not be withdrawn.');
    }
  };

  const review = async (application: OrganizerApplication, decision: 'approve' | 'reject') => {
    setError('');
    setBusy(true);
    try {
      await api(`/organizer-applications/${application.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, note: reviewNotes[application.id] ?? '' }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The application could not be reviewed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <PageTitle eyebrow="CLUB ORGANIZING" title={canReview ? 'Organizer applications' : 'Apply to become an organizer'} description="Students can apply from their existing account. Each club can have at most three pending or approved applications and organizers." />
      {!canReview && !account.organizerEnabled && !account.adminEnabled && account.role === 'student' && <form className="application-form panel" onSubmit={(event) => void submit(event)}>
        <label>Club or organization<input required minLength={2} maxLength={120} value={clubName} onChange={(event) => setClubName(event.target.value)} placeholder="e.g. Tech Society" /></label>
        <label>Your position in the club<input required minLength={2} maxLength={100} value={position} onChange={(event) => setPosition(event.target.value)} placeholder="e.g. Chairperson" /></label>
        <label>Why do you want to organize events?<textarea required minLength={20} maxLength={1500} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Tell reviewers about your role and the events you plan to organize." /></label>
        <p className="field-note">Faculty and course come from your profile. A pending application reserves one of the club’s three places. Rejected or withdrawn applications free their place.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit application'} <ArrowRight size={16} /></button>
      </form>}
      {account.organizerEnabled && account.role === 'student' && !canReview && <div className="success-banner"><CheckCircle2 size={18} />Your Organizer access is approved. Switch to the Organizer workspace to manage events.</div>}
      {mine.length > 0 && <section className="application-section"><h2>My applications</h2>{mine.map((application) => <article className="application-card" key={application.id}>
        <div className="application-card-heading"><div><b>{application.clubName}</b><small>{application.position} · Submitted {formatDate(application.createdAt, { year: 'numeric' })}</small></div><span className={`status-pill status-${application.status === 'approved' ? 'on' : application.status === 'rejected' ? 'error' : application.status === 'withdrawn' ? 'muted' : 'draft'}`}>{application.status}</span></div>
        <p>{application.reason}</p>{application.reviewNote && <small className="field-note">Reviewer note: {application.reviewNote}</small>}
        {application.status === 'pending' && <button className="text-button" onClick={() => void withdraw(application.id)}>Withdraw application</button>}
      </article>)}</section>}
      {canReview && <section className="application-section"><h2>Pending review <span>{queue.length}</span></h2>{queue.length ? queue.map((application) => <article className="application-card" key={application.id}>
        <div className="application-card-heading"><div><b>{application.applicantName} · {application.clubName}</b><small>{application.applicantEmail} · {application.position}</small><small>{[application.course, application.faculty].filter(Boolean).join(' · ')}</small></div><small>{formatDate(application.createdAt, { year: 'numeric' })}</small></div>
        <p>{application.reason}</p><label>Review note<textarea maxLength={500} rows={2} value={reviewNotes[application.id] ?? ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [application.id]: event.target.value }))} placeholder="Optional note for the applicant" /></label>
        <div className="application-review-actions"><button className="button button-secondary button-small" disabled={busy} onClick={() => void review(application, 'reject')}>Decline</button><button className="button button-primary button-small" disabled={busy} onClick={() => void review(application, 'approve')}>Approve organizer</button></div>
      </article>) : <EmptyState icon={<CheckCircle2 />} title="No applications waiting" description="New club organizer applications will appear here." />}</section>}
      {!mine.length && !canReview && !account.organizerEnabled && <div className="application-section"><h2>My applications</h2><p className="field-note">You haven’t submitted an application yet.</p></div>}
    </div>
  );
}

function CreateEventPage({ onSave, editing, onRooms }: {
  onSave: (payload: Record<string, unknown>) => Promise<CampusEvent>;
  editing: CampusEvent | null;
  onRooms: (event: CampusEvent) => void;
}) {
  const initialStart = new Date(Date.now() + 4 * 24 * 60 * 60_000);
  initialStart.setHours(14, 0, 0, 0);
  const [form, setForm] = useState({
    title: editing?.title ?? '',
    description: editing?.description ?? '',
    category: editing?.category ?? categories[0],
    deliveryMode: editing?.deliveryMode ?? 'in_person',
    faculty: editing?.faculty ?? '',
    clubName: editing?.clubName ?? '',
    startAt: editing ? localDateTime(new Date(editing.startAt)) : localDateTime(initialStart),
    endAt: editing ? localDateTime(new Date(editing.endAt)) : localDateTime(new Date(initialStart.getTime() + 60 * 60_000)),
    registrationClosesAt: editing ? localDateTime(new Date(editing.registrationClosesAt)) : localDateTime(new Date(initialStart.getTime() - 24 * 60 * 60_000)),
    expectedAttendance: editing?.expectedAttendance ?? 50,
    registrationCapacity: editing?.registrationCapacity ?? '',
    meetingUrl: editing?.meetingUrl ?? '',
    requiredFacilities: editing?.requiredFacilities ?? [],
  });
  const [error, setError] = useState('');
  const [savedEvent, setSavedEvent] = useState<CampusEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: string | number | string[]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { registrationCapacity, ...rest } = form;
      const payload = {
        ...rest,
        startAt: new Date(form.startAt).toISOString(),
        endAt: new Date(form.endAt).toISOString(),
        registrationClosesAt: new Date(form.registrationClosesAt).toISOString(),
        expectedAttendance: Number(form.expectedAttendance),
        ...(registrationCapacity === '' ? {} : { registrationCapacity: Number(registrationCapacity) }),
        clubName: form.clubName || null,
        meetingUrl: form.meetingUrl || null,
      };
      setSavedEvent(await onSave(payload));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The event could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  if (savedEvent) {
    return <div className="page-stack"><PageTitle eyebrow="DRAFT SAVED" title="Your event is taking shape." description="It will stay private until you publish it." /><div className="next-step-card"><div className="next-step-icon"><CheckCircle2 size={24} /></div><div><h2>{savedEvent.title}</h2><p>Next, confirm a room for an in-person event or add a meeting link for an online event.</p></div>{savedEvent.deliveryMode !== 'online' && <button className="button button-primary" onClick={() => onRooms(savedEvent)}>Find a room <ArrowRight size={16} /></button>}</div><div className="form-actions"><button className="button button-secondary" onClick={() => setSavedEvent(null)}>Continue editing</button><button className="button button-secondary" onClick={() => onRooms(savedEvent)}>Room allocation</button></div></div>;
  }
  return (
    <div className="page-stack">
      <PageTitle eyebrow={editing ? 'UPDATE YOUR EVENT' : 'BRING YOUR IDEA TO CAMPUS'} title={editing ? 'Edit event' : 'Create an event'} description="Start with the essentials. You can review everything before it goes live." />
      <form className="create-layout" onSubmit={(event) => void submit(event)}>
        <div className="create-form panel">
          <label>Event name<input required minLength={4} maxLength={120} value={form.title} onChange={(event) => set('title', event.target.value)} placeholder="e.g. Design thinking workshop" /></label>
          <label>About this event<textarea required minLength={20} maxLength={4000} rows={5} value={form.description} onChange={(event) => set('description', event.target.value)} placeholder="What will students learn, see, or do?" /></label>
          <div className="form-two-col"><label>Faculty or school<input required value={form.faculty} onChange={(event) => set('faculty', event.target.value)} placeholder="e.g. School of Computing" /></label><label>Category<select value={form.category} onChange={(event) => set('category', event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <div className="form-two-col"><label>Event type<select value={form.deliveryMode} onChange={(event) => set('deliveryMode', event.target.value)}><option value="in_person">In-person</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label><label>Club or community<input value={form.clubName} onChange={(event) => set('clubName', event.target.value)} placeholder="Optional" /></label></div>
          <div className="form-two-col"><label>Starts<input required type="datetime-local" value={form.startAt} onChange={(event) => set('startAt', event.target.value)} /></label><label>Ends<input required type="datetime-local" value={form.endAt} onChange={(event) => set('endAt', event.target.value)} /></label></div>
          <label>Registration closes<input required type="datetime-local" value={form.registrationClosesAt} onChange={(event) => set('registrationClosesAt', event.target.value)} /><small className="field-note">The default is 24 hours before the event starts.</small></label>
          <div className="form-two-col"><label>Expected attendance<input required min={1} max={10000} type="number" value={form.expectedAttendance} onChange={(event) => set('expectedAttendance', Number(event.target.value))} /></label><label>Registration capacity<input min={1} max={10000} type="number" value={form.registrationCapacity} onChange={(event) => set('registrationCapacity', event.target.value === '' ? '' : Number(event.target.value))} placeholder={form.deliveryMode === 'online' ? 'Defaults to expected attendance' : 'Defaults to room capacity'} /><small className="field-note">Leave blank to use the room capacity, or expected attendance for Online events.</small></label></div>
          {form.deliveryMode !== 'online' && <fieldset><legend>Required facilities</legend><div className="facility-checks">{facilities.map((item) => <label key={item}><input type="checkbox" checked={form.requiredFacilities.includes(item)} onChange={() => set('requiredFacilities', form.requiredFacilities.includes(item) ? form.requiredFacilities.filter((facility) => facility !== item) : [...form.requiredFacilities, item])} />{item}</label>)}</div></fieldset>}
          {(form.deliveryMode === 'online' || form.deliveryMode === 'hybrid') && <label>Meeting link<input type="url" required={form.deliveryMode === 'online'} value={form.meetingUrl} onChange={(event) => set('meetingUrl', event.target.value)} placeholder="https://…" /></label>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="form-actions"><button type="button" className="button button-secondary">Save draft</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={16} /></button></div>
        </div>
        <aside className="create-aside">
          <div className="aside-tip"><span><Sparkles size={17} /></span><strong>Room fit, made clearer</strong><p>We’ll check verified capacity, required facilities, and schedule conflicts. A person confirms every allocation.</p></div>
          <div className="aside-tip"><span><Bell size={17} /></span><strong>Keep students in the loop</strong><p>Confirmed students receive in-app updates for reminders, registration, and important changes.</p></div>
          <div className="draft-note"><ShieldCheck size={17} /> Your event stays a draft until you publish it.</div>
        </aside>
      </form>
    </div>
  );
}

function RoomsPage({ events, selectedId, onSelectEvent, onConfirmRoom, conflictsOnly }: {
  events: CampusEvent[];
  selectedId: string;
  onSelectEvent: (eventId: string) => void;
  onConfirmRoom: (eventId: string, roomId: string) => Promise<void>;
  conflictsOnly?: boolean;
}) {
  const candidates = events.filter((event) => event.status === 'draft' && event.deliveryMode !== 'online');
  const [configured, setConfigured] = useState(false);
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selected = candidates.find((event) => event.id === selectedId) ?? candidates[0];
  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError('');
    api<{ configured: boolean; recommendations: RoomOption[] }>(`/events/${selected.id}/room-options`)
      .then((result) => { setConfigured(result.configured); setRooms(result.recommendations); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load room options.'))
      .finally(() => setLoading(false));
  }, [selected?.id]);
  const eligible = rooms.filter((room) => room.eligible);
  return (
    <div className="page-stack">
      <PageTitle eyebrow={conflictsOnly ? 'SCHEDULE CHECK' : 'SMART ROOM ALLOCATION'} title={conflictsOnly ? 'Conflict detection' : 'Find a room that fits.'} description={conflictsOnly ? 'See room conflicts and suitable alternatives before publishing.' : 'The organizer stays in control. CampusConnect checks availability, capacity, and required facilities.'} />
      {candidates.length > 0 && <label className="event-select-label">Draft event<select value={selected?.id ?? ''} onChange={(event) => onSelectEvent(event.target.value)}>{candidates.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {selected && <div className="allocation-event-summary"><span className="event-summary-icon"><CalendarDays size={19} /></span><div><b>{selected.title}</b><small>{formatDate(selected.startAt)} · {formatTime(selected.startAt)}–{formatTime(selected.endAt)} · Expected {selected.expectedAttendance}</small></div><span className="status-pill status-draft">Draft</span></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {!selected ? <EmptyState icon={<DoorOpen />} title="No in-person drafts yet" description="Create an in-person or hybrid event to check room fit." /> : loading ? <div className="loading-panel">Checking verified room inventory…</div> : !configured ? (
        <div className="inventory-empty">
          <div className="inventory-illustration"><DoorOpen size={38} /><span>?</span></div>
          <div className="eyebrow">VERIFIED INVENTORY REQUIRED</div>
          <h2>Room allocation is not configured yet.</h2>
          <p>The admin has not supplied verified capacity and facility data for TC1–TC54, the amphitheatre, or pavilion. No rooms will be recommended until that inventory is available.</p>
          <div className="inventory-checklist"><span><Check size={15} /> Verified room capacity</span><span><Check size={15} /> Confirmed facilities</span><span><Check size={15} /> Booking and setup rules</span></div>
        </div>
      ) : (
        <>
          <div className="allocation-score-note"><Sparkles size={17} /><span>Eligible rooms meet every hard requirement. Fit score = expected attendance ÷ room capacity.</span></div>
          {conflictsOnly && rooms.some((room) => room.conflict) && <div className="conflict-alert"><span><ShieldCheck size={19} /></span><div><strong>Schedule conflicts found</strong><p>One or more rooms overlap with another booking. Choose an eligible alternative or reschedule.</p></div></div>}
          <div className="room-table-wrap"><table className="room-table"><thead><tr><th>Room</th><th>Capacity</th><th>Facilities</th><th>Fit score</th><th>Status</th><th /></tr></thead><tbody>{rooms.map((room) => <tr key={room.roomId} className={room.eligible ? '' : 'room-ineligible'}><td><strong>{room.name}</strong><small>{room.code}</small></td><td>{room.capacity} seats</td><td><div className="facility-pills">{room.facilities.map((item) => <span key={item}>{item}</span>)}</div>{room.missingFacilities.length > 0 && <small className="missing-facility">Missing {room.missingFacilities.join(', ')}</small>}</td><td><strong>{room.capacityFitScore}%</strong><small>capacity fit</small></td><td>{room.conflict ? <span className="status-pill status-error">Conflict</span> : room.eligible ? <span className="status-pill status-on">Available</span> : <span className="status-pill status-muted">Not suitable</span>}</td><td>{room.eligible && <button className="button button-small button-primary" onClick={() => void onConfirmRoom(selected.id, room.roomId)}>Confirm</button>}</td></tr>)}</tbody></table></div>
          {!eligible.length && <EmptyState icon={<DoorOpen />} title="No suitable room found" description="Review required facilities, expected attendance, or the event time." />}
          {!!eligible.length && selected.roomId && <div className="success-banner"><CheckCircle2 size={18} /> Room allocation confirmed. Review the event and publish when ready.</div>}
        </>
      )}
      <div className="allocation-footer"><span><ShieldCheck size={15} /> Recommendations never book a room automatically.</span><button className="text-button" onClick={() => window.location.hash = '#create'}>Reschedule event <ArrowRight size={14} /></button></div>
    </div>
  );
}

function AnalyticsPage({ events }: { events: CampusEvent[] }) {
  const [data, setData] = useState<{
    totals: { totalEvents: number; upcomingEvents: number; registeredStudents: number; attendanceRate: number };
    categories: Array<{ category: string; count: number }>;
    predictions: Array<{ event: CampusEvent; estimate: number; lowerBound: number; upperBound: number; historySamples: number }>;
    roomUtilization: { configuredRooms: number; currentlyBookedRooms: number };
    predictionMethod: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<typeof data>('/organizer/analytics').then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load analytics.'));
  }, [events.length]);
  const max = Math.max(1, ...(data?.categories.map((item) => item.count) ?? []));
  return (
    <div className="page-stack">
      <PageTitle eyebrow="A CLEARER PICTURE" title="Event analytics" description="A few signals to help you plan the next campus moment." />
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dashboard-stats">{[
        ['Total events', data?.totals.totalEvents ?? events.length, <CalendarDays />],
        ['Upcoming events', data?.totals.upcomingEvents ?? 0, <Clock3 />],
        ['Registered students', data?.totals.registeredStudents ?? 0, <Users />],
        ['Historical turnout', `${data?.totals.attendanceRate ?? 0}%`, <ArrowUpRight />],
      ].map(([label, value, icon], index) => <StatCard key={String(label)} label={String(label)} value={String(value)} detail={index === 3 ? 'Seeded sample history' : 'Across the campus'} icon={icon as ReactNode} tone={['blue', 'lavender', 'green', 'amber'][index]} />)}</div>
      <div className="analytics-grid">
        <section className="panel analytics-panel"><div className="panel-heading"><div><p className="eyebrow">WHAT’S DRAWING INTEREST</p><h2>Popular categories</h2></div><span className="panel-icon"><Heart size={18} /></span></div>{data?.categories.length ? <div className="bar-list">{data.categories.map((item) => <div className="bar-row" key={item.category}><div><span>{item.category}</span><b>{item.count}</b></div><div className="bar-track"><i style={{ width: `${Math.max(8, item.count / max * 100)}%` }} /></div></div>)}</div> : <p className="muted">Category activity will appear as events are published.</p>}</section>
        <section className="panel analytics-panel"><div className="panel-heading"><div><p className="eyebrow">SPACE PLANNING</p><h2>Room utilization</h2></div><span className="panel-icon"><DoorOpen size={18} /></span></div><div className="utilization-empty"><div className="utilization-ring"><span>{data?.roomUtilization.configuredRooms ?? 0}<small> rooms</small></span></div><p>{data?.roomUtilization.configuredRooms ? `${data.roomUtilization.currentlyBookedRooms} currently booked` : 'Waiting for verified room inventory'}</p></div></section>
      </div>
      <section className="panel prediction-panel"><div className="panel-heading"><div><p className="eyebrow">PLAN WITH CONTEXT</p><h2>Attendance predictions</h2></div><span className="prediction-badge"><Sparkles size={14} /> Estimate, not a promise</span></div><p className="muted">{data?.predictionMethod ?? 'Confirmed registrations multiplied by seeded historical check-in rate.'}</p>{data?.predictions.map((item) => <div className="prediction-row" key={item.event.id}><div><b>{item.event.title}</b><small>{item.historySamples} historical sample events</small></div><div className="prediction-range"><strong>{item.estimate}</strong><span>{item.lowerBound}–{item.upperBound} expected</span></div></div>)}</section>
      <p className="disclaimer"><ShieldCheck size={15} /> Estimates use fictional seeded history. Room statistics remain unavailable until verified inventory is provided.</p>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><GraduationCap size={21} /></span><span>campus<span className="brand-connect">connect</span><small>YOUR CAMPUS, CONNECTED</small></span></div>;
}

function AdministratorDashboard({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  return <div className="page-stack">
    <PageTitle eyebrow="ADMINISTRATOR WORKSPACE" title="Campus administration" description="Manage accounts and verified rooms, review organizer applications, and view campus reports." />
    <section className="admin-shortcuts">
      <button onClick={() => onNavigate('admin-users')}><Users size={20} /><span><b>Manage users</b><small>View accounts and enable or suspend access</small></span><ArrowRight size={16} /></button>
      <button onClick={() => onNavigate('rooms')}><DoorOpen size={20} /><span><b>Manage rooms</b><small>Maintain verified venue capacity and facilities</small></span><ArrowRight size={16} /></button>
      <button onClick={() => onNavigate('applications')}><ShieldCheck size={20} /><span><b>Approve organizers</b><small>Review club applications and the three person cap</small></span><ArrowRight size={16} /></button>
      <button onClick={() => onNavigate('analytics')}><ArrowUpRight size={20} /><span><b>Generate reports</b><small>Review campus events and attendance estimates</small></span><ArrowRight size={16} /></button>
    </section>
  </div>;
}

function AdminUsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const refresh = useCallback(async () => {
    const result = await api<{ users: ManagedUser[] }>('/admin/users');
    setUsers(result.users);
  }, []);
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Users could not be loaded.')); }, [refresh]);
  const toggleActive = async (user: ManagedUser) => {
    setBusyId(user.id);
    setError('');
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !user.isActive }) });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'User access could not be updated.');
    } finally { setBusyId(''); }
  };
  return <div className="page-stack">
    <PageTitle eyebrow="ACCOUNT DIRECTORY" title="Manage users" description="Review student, organizer, and administrator accounts. Deactivated accounts can no longer sign in." />
    {error && <div className="form-error" role="alert">{error}</div>}
    {users.length ? <div className="admin-user-list">{users.map((user) => <article className="admin-user-card" key={user.id}>
      <span className="avatar">{initials(user.displayName)}</span><div className="admin-user-copy"><b>{user.displayName}</b><small>{user.email}</small><small>{[user.course, user.faculty].filter(Boolean).join(' · ') || 'No faculty or course entered'}</small></div>
      <div className="admin-user-flags"><span className={`status-pill ${user.isActive ? 'status-on' : 'status-error'}`}>{user.isActive ? 'Active' : 'Inactive'}</span>{user.adminEnabled ? <span className="role-pill">Administrator</span> : user.organizerEnabled || user.role === 'organizer' ? <span className="role-pill">Organizer</span> : <span className="role-pill">Student</span>}</div>
      {!user.adminEnabled && <button className={`button button-small ${user.isActive ? 'button-secondary' : 'button-primary'}`} disabled={busyId === user.id} onClick={() => void toggleActive(user)}>{busyId === user.id ? 'Saving…' : user.isActive ? 'Deactivate' : 'Reactivate'}</button>}
    </article>)}</div> : <div className="loading-panel">Loading accounts…</div>}
  </div>;
}

function AdminRoomsPage() {
  const empty = { code: '', name: '', capacity: 30, facilities: '', bufferMinutes: 0, verified: false };
  const [rooms, setRooms] = useState<ManagedRoom[]>([]);
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const result = await api<{ rooms: ManagedRoom[] }>('/admin/rooms');
    setRooms(result.rooms);
  }, []);
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Rooms could not be loaded.')); }, [refresh]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const payload = { ...form, facilities: form.facilities.split(',').map((item) => item.trim()).filter(Boolean) };
    try {
      await api(editingId ? `/admin/rooms/${editingId}` : '/admin/rooms', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setForm(empty);
      setEditingId('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The room could not be saved.');
    } finally { setBusy(false); }
  };
  const edit = (room: ManagedRoom) => {
    setEditingId(room.id);
    setForm({ code: room.code, name: room.name, capacity: room.capacity, facilities: room.facilities.join(', '), bufferMinutes: room.bufferMinutes, verified: room.verified });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const remove = async (room: ManagedRoom) => {
    setError('');
    try {
      await api(`/admin/rooms/${room.id}`, { method: 'DELETE' });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The room could not be removed.');
    }
  };
  return <div className="page-stack">
    <PageTitle eyebrow="VENUE INVENTORY" title="Manage rooms" description="Add and maintain room facts. Only verified rooms can be allocated to events." />
    <form className="admin-room-form panel" onSubmit={(event) => void save(event)}>
      <h2>{editingId ? 'Edit room' : 'Add a room'}</h2>
      <div className="form-two-col"><label>Room code<input required maxLength={40} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="e.g. LIB-101" /></label><label>Room name<input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Library Seminar Room" /></label></div>
      <div className="form-two-col"><label>Capacity<input required type="number" min={1} max={10000} value={form.capacity} onChange={(event) => setForm({ ...form, capacity: Number(event.target.value) })} /></label><label>Setup buffer (minutes)<input required type="number" min={0} max={1440} value={form.bufferMinutes} onChange={(event) => setForm({ ...form, bufferMinutes: Number(event.target.value) })} /></label></div>
      <label>Facilities, separated by commas<input value={form.facilities} onChange={(event) => setForm({ ...form, facilities: event.target.value })} placeholder="Projector, Internet" /></label>
      <label className="admin-verified-check"><input type="checkbox" checked={form.verified} onChange={(event) => setForm({ ...form, verified: event.target.checked })} /> Mark these room details as verified</label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save room' : 'Add room'}</button>{editingId && <button type="button" className="button button-secondary" onClick={() => { setEditingId(''); setForm(empty); }}>Cancel edit</button>}</div>
    </form>
    {rooms.length ? <div className="admin-room-list">{rooms.map((room) => <article className="admin-room-card" key={room.id}><span className="event-summary-icon"><DoorOpen size={19} /></span><div><b>{room.name} <small>{room.code}</small></b><span>{room.capacity} seats · {room.facilities.join(', ') || 'No facilities listed'} · {room.bufferMinutes} min buffer</span></div><span className={`status-pill ${room.verified ? 'status-on' : 'status-muted'}`}>{room.verified ? 'Verified' : 'Unverified'}</span><button className="button button-small button-secondary" onClick={() => edit(room)}>Edit</button><button className="button button-small button-secondary" onClick={() => void remove(room)}>Remove</button></article>)}</div> : <EmptyState icon={<DoorOpen />} title="No rooms yet" description="Add room details and mark them verified before organizers can allocate them." />}
  </div>;
}

const studentNav = [
  { id: 'dashboard' as const, label: 'Home', icon: LayoutDashboard },
  { id: 'discover' as const, label: 'Discover', icon: Compass },
  { id: 'calendar' as const, label: 'Calendar', icon: CalendarDays },
];
const studentMoreNav = [
  { id: 'recommendations' as const, label: 'For you', icon: Sparkles },
  { id: 'notifications' as const, label: 'Notifications', icon: Bell },
  { id: 'applications' as const, label: 'Apply to organize', icon: Users },
  { id: 'profile' as const, label: 'Profile & interests', icon: Heart },
];
const organizerNav = [
  { id: 'dashboard' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'events' as const, label: 'Events', icon: CalendarDays },
  { id: 'create' as const, label: 'Create', icon: Plus },
];
const organizerMoreNav = [
  { id: 'rooms' as const, label: 'Rooms', icon: DoorOpen },
  { id: 'conflicts' as const, label: 'Conflicts', icon: ShieldCheck },
  { id: 'analytics' as const, label: 'Analytics', icon: ArrowUpRight },
  { id: 'notifications' as const, label: 'Notifications', icon: Bell },
  { id: 'profile' as const, label: 'Profile', icon: Heart },
];
const administratorNav = [
  { id: 'dashboard' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'admin-users' as const, label: 'Users', icon: Users },
  { id: 'rooms' as const, label: 'Rooms', icon: DoorOpen },
  { id: 'analytics' as const, label: 'Reports', icon: ArrowUpRight },
];
const administratorMoreNav = [
  { id: 'applications' as const, label: 'Organizer applications', icon: ShieldCheck },
  { id: 'profile' as const, label: 'Profile', icon: Heart },
];

export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [workspace, setWorkspace] = useState<'student' | 'organizer' | 'administrator'>('student');
  const [screen, setScreen] = useState<Screen>('landing');
  const [events, setEvents] = useState<CampusEvent[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup' | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [moreNavOpen, setMoreNavOpen] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('campusconnect-saved') ?? '[]') as string[]; } catch { return []; }
  });
  const selectedEvent = events.find((event) => event.id === selectedId) ?? null;
  const administrator = account?.adminEnabled === true && workspace === 'administrator';
  const organizer = !administrator && (account?.role === 'organizer' || (account?.organizerEnabled === true && workspace === 'organizer'));
  const hasOrganizerWorkspace = account?.role === 'organizer' || account?.organizerEnabled === true;
  const hasAdminWorkspace = account?.adminEnabled === true;
  const nav = administrator ? administratorNav : organizer ? organizerNav : studentNav;
  const secondaryNav = administrator ? administratorMoreNav : organizer ? organizerMoreNav : studentMoreNav;
  const secondaryNavActive = secondaryNav.some(({ id }) => id === screen);
  const showSecondaryNav = moreNavOpen || secondaryNavActive;

  const loadData = useCallback(async (current: Account) => {
    const eventResult = await api<{ events: CampusEvent[] }>('/events');
    setEvents(eventResult.events);
    const tasks: Promise<void>[] = [
      api<{ notifications: NotificationItem[] }>('/notifications').then((result) => setNotifications(result.notifications)),
    ];
    if (current.role === 'student') {
      tasks.push(api<{ recommendations: Recommendation[] }>('/recommendations').then((result) => setRecommendations(result.recommendations)));
      tasks.push(api<{ events: CampusEvent[] }>('/calendar').then((result) => {
        setEvents((existing) => {
          const map = new Map(existing.map((event) => [event.id, event]));
          result.events.forEach((event) => map.set(event.id, event));
          return [...map.values()];
        });
      }));
    } else {
      setRecommendations([]);
    }
    await Promise.all(tasks);
  }, []);

  useEffect(() => {
    api<{ account: Account }>('/auth/me')
      .then(async (result) => { setAccount(result.account); setWorkspace(result.account.adminEnabled ? 'administrator' : result.account.role === 'organizer' ? 'organizer' : 'student'); setScreen('dashboard'); await loadData(result.account); })
      .catch(() => undefined)
      .finally(() => setBusy(false));
    api<{ events: CampusEvent[] }>('/events').then((result) => setEvents(result.events)).catch(() => undefined);
  }, [loadData]);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  };

  const navigate = (next: Screen) => {
    if (next === 'create' && screen !== 'details') setSelectedId('');
    setScreen(next);
    setMoreNavOpen(secondaryNav.some(({ id }) => id === next));
    setMobileMenu(false);
    setError('');
    if (next === 'events' || next === 'discover') {
      api<{ events: CampusEvent[] }>('/events').then((result) => setEvents(result.events)).catch((reason) => setError(reason.message));
    }
    if (next === 'notifications' && account) {
      api<{ notifications: NotificationItem[] }>('/notifications').then((result) => setNotifications(result.notifications)).catch((reason) => setError(reason.message));
    }
  };

  const handleAuth = async (nextAccount: Account) => {
    setAccount(nextAccount);
    setWorkspace(nextAccount.adminEnabled ? 'administrator' : nextAccount.role === 'organizer' ? 'organizer' : 'student');
    setAuthMode(null);
    setScreen('dashboard');
    try { await loadData(nextAccount); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Some data could not be loaded.'); }
    flash(`Welcome to CampusConnect, ${nextAccount.displayName.split(' ')[0]}.`);
  };

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    setAccount(null);
    setWorkspace('student');
    setScreen('landing');
    setEvents([]);
    setRecommendations([]);
    setNotifications([]);
  };

  const register = async (event: CampusEvent) => {
    try {
      const result = await api<{ status: string }>(`/events/${event.id}/register`, { method: 'POST' });
      flash(result.status === 'registered' ? 'You’re registered. We saved your seat.' : 'You’re on the waitlist. We’ll let you know if a seat opens.');
      if (account) await loadData(account);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : 'Registration could not be completed.');
    }
  };

  const cancelRegistration = async (event: CampusEvent) => {
    try {
      await api(`/events/${event.id}/register`, { method: 'DELETE' });
      flash('Your registration has been cancelled.');
      if (account) await loadData(account);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : 'Registration could not be cancelled.');
    }
  };

  const toggleSaved = (eventId: string) => {
    const next = savedIds.includes(eventId) ? savedIds.filter((id) => id !== eventId) : [...savedIds, eventId];
    setSavedIds(next);
    localStorage.setItem('campusconnect-saved', JSON.stringify(next));
    flash(next.includes(eventId) ? 'Event saved for later.' : 'Event removed from saved items.');
  };

  const createOrUpdateEvent = async (payload: Record<string, unknown>) => {
    const result = await api<{ event: CampusEvent }>(screen === 'create' && selectedEvent ? `/events/${selectedEvent.id}` : '/events', {
      method: screen === 'create' && selectedEvent ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    const refreshed = await api<{ events: CampusEvent[] }>('/events');
    setEvents(refreshed.events);
    flash('Draft saved.');
    return result.event;
  };

  const publishEvent = async (event: CampusEvent) => {
    try {
      await api(`/events/${event.id}/publish`, { method: 'POST' });
      const refreshed = await api<{ events: CampusEvent[] }>('/events');
      setEvents(refreshed.events);
      flash('Your event is now published.');
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : 'The event could not be published.');
    }
  };

  const cancelEvent = async (event: CampusEvent) => {
    if (!window.confirm(`Cancel “${event.title}”? Registrants will be notified.`)) return;
    try {
      await api(`/events/${event.id}/cancel`, { method: 'POST' });
      const refreshed = await api<{ events: CampusEvent[] }>('/events');
      setEvents(refreshed.events);
      flash('Event cancelled and registrants notified.');
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : 'The event could not be cancelled.');
    }
  };

  const openEvent = (event: CampusEvent) => {
    setSelectedId(event.id);
    setScreen('details');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const confirmRoom = async (eventId: string, roomId: string) => {
    try {
      await api(`/events/${eventId}/room`, { method: 'POST', body: JSON.stringify({ roomId }) });
      const refreshed = await api<{ events: CampusEvent[] }>('/events');
      setEvents(refreshed.events);
      flash('Room allocation confirmed.');
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : 'Room allocation failed.');
    }
  };

  const updateProfile = async (patch: Record<string, unknown>) => {
    const result = await api<{ account: Account }>('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) });
    setAccount(result.account);
    await loadData(result.account);
  };

  const markRead = async (item: NotificationItem) => {
    if (!item.readAt) {
      await api(`/notifications/${item.id}/read`, { method: 'PATCH' });
      setNotifications((current) => current.map((notification) => notification.id === item.id ? { ...notification, readAt: new Date().toISOString() } : notification));
    }
    if (item.eventId) {
      const event = events.find((candidate) => candidate.id === item.eventId);
      if (event) openEvent(event);
    }
  };

  if (busy) return <div className="app-loading"><span className="loading-mark"><GraduationCap size={25} /></span><span>Opening your campus…</span></div>;

  if (!account) {
    return (
      <div className="public-shell">
        <header className="public-header"><Brand /><div className="public-nav"><button onClick={() => document.getElementById('events')?.scrollIntoView({ behavior: 'smooth' })}>Explore</button><button onClick={() => document.getElementById('benefits')?.scrollIntoView({ behavior: 'smooth' })}>About</button></div><div className="public-actions"><button className="button button-text" onClick={() => setAuthMode('login')}>Sign in</button><button className="button button-primary" onClick={() => setAuthMode('signup')}>Register <ArrowRight size={15} /></button></div></header>
        <LandingPage events={events} onAuth={setAuthMode} onOpen={openEvent} />
        {screen === 'details' && selectedEvent && <div className="public-details-overlay"><div className="public-details-box"><button className="icon-button close-public-details" onClick={() => setScreen('landing')} aria-label="Close event details"><X size={19} /></button><EventDetails event={selectedEvent} account={null} saved={savedIds.includes(selectedEvent.id)} onSave={() => toggleSaved(selectedEvent.id)} onRegister={() => setAuthMode('signup')} onCancelRegistration={() => undefined} onBack={() => setScreen('landing')} onEdit={() => undefined} /></div></div>}
        {authMode && <AuthDialog initialMode={authMode} onClose={() => setAuthMode(null)} onSuccess={(nextAccount) => void handleAuth(nextAccount)} />}
        {toast && <div className="toast-message" role="status">{toast}</div>}
      </div>
    );
  }

  const activeEvent = selectedEvent;
  const unread = notifications.filter((item) => !item.readAt).length;
  const content = (() => {
    if (screen === 'details' && activeEvent) return <EventDetails event={activeEvent} account={account} saved={savedIds.includes(activeEvent.id)} organizerWorkspace={organizer} onSave={() => toggleSaved(activeEvent.id)} onRegister={() => void register(activeEvent)} onCancelRegistration={() => void cancelRegistration(activeEvent)} onBack={() => navigate(organizer ? 'events' : 'discover')} onEdit={() => { setSelectedId(activeEvent.id); navigate('create'); }} />;
    if (screen === 'discover') return <DiscoveryPage events={events} onOpen={openEvent} onRegister={(event) => void register(event)} onSave={toggleSaved} savedIds={savedIds} />;
    if (screen === 'calendar') return <CalendarPage events={events} onOpen={openEvent} />;
    if (screen === 'recommendations') return <RecommendationsPage items={recommendations} onOpen={openEvent} onRegister={(event) => void register(event)} />;
    if (screen === 'notifications') return <NotificationsPage notifications={notifications} onRead={(item) => void markRead(item)} />;
    if (screen === 'applications') return <OrganizerApplicationsPage account={account} canReview={administrator} onAccountUpdated={setAccount} />;
    if (screen === 'admin-users' && administrator) return <AdminUsersPage />;
    if (screen === 'profile') return <ProfilePage account={account} onUpdate={updateProfile} />;
    if (screen === 'events') return <OrganizerEventsPage events={events} onOpen={openEvent} onNavigate={navigate} onPublish={(event) => void publishEvent(event)} onCancel={(event) => void cancelEvent(event)} />;
    if (screen === 'create') return <CreateEventPage key={selectedEvent?.id ?? 'new'} editing={selectedEvent} onSave={createOrUpdateEvent} onRooms={(event) => { setSelectedId(event.id); navigate('rooms'); }} />;
    if (screen === 'rooms' && administrator) return <AdminRoomsPage />;
    if (screen === 'rooms' || screen === 'conflicts') return <RoomsPage events={events} selectedId={selectedId} onSelectEvent={setSelectedId} onConfirmRoom={confirmRoom} conflictsOnly={screen === 'conflicts'} />;
    if (screen === 'analytics') return <AnalyticsPage events={events} />;
    if (administrator) return <AdministratorDashboard onNavigate={navigate} />;
    if (organizer) return <OrganizerDashboard events={events} onNavigate={navigate} onOpen={openEvent} />;
    return <StudentDashboard account={account} events={events} recommendations={recommendations} onNavigate={navigate} onOpen={openEvent} onRegister={(event) => void register(event)} savedIds={savedIds} onSave={toggleSaved} />;
  })();

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand"><Brand compact /><button className="icon-button mobile-close" onClick={() => setMobileMenu(false)} aria-label="Close navigation"><X size={18} /></button></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }) => <button className={`nav-item ${screen === id || (screen === 'details' && id === (organizer ? 'events' : 'discover')) ? 'active' : ''}`} key={id} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span></button>)}
          <button
            className={`nav-item nav-disclosure ${secondaryNavActive ? 'active' : ''}`}
            onClick={() => setMoreNavOpen((open) => !open)}
            aria-expanded={showSecondaryNav}
            aria-controls="secondary-navigation"
          >
            <MoreHorizontal size={18} /><span>More</span><ChevronDown className={showSecondaryNav ? 'expanded' : ''} size={15} />
          </button>
          <div className="nav-subnav" id="secondary-navigation" hidden={!showSecondaryNav}>
            {secondaryNav.map(({ id, label, icon: Icon }) => <button className={`nav-item nav-item-secondary ${screen === id ? 'active' : ''}`} key={id} onClick={() => navigate(id)}><Icon size={17} /><span>{label}</span>{id === 'notifications' && unread > 0 && <small className="nav-count">{unread}</small>}</button>)}
          </div>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-help"><span className="help-mark"><GraduationCap size={18} /></span><b>A little campus magic</b><small>Thoughtful events start with a good plan.</small><button onClick={() => navigate(administrator ? 'analytics' : organizer ? 'analytics' : 'recommendations')}>Explore <ArrowRight size={13} /></button></div>
        <button className="sidebar-account" onClick={() => navigate('profile')}><span className="avatar">{initials(account.displayName)}</span><span><b>{account.displayName}</b><small>{administrator ? 'Administrator' : organizer ? 'Event organizer' : 'Student account'}</small></span><ChevronDown size={16} /></button>
      </aside>
      {mobileMenu && <button className="mobile-backdrop" onClick={() => setMobileMenu(false)} aria-label="Close menu" />}
      <main className="main-shell">
        <header className="topbar"><button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumb"><span>CampusConnect</span><ChevronRight size={14} /><b>{screen === 'dashboard' ? 'Overview' : screen.replace('-', ' ')}</b></div><div className="topbar-actions">{(hasOrganizerWorkspace || hasAdminWorkspace) && <select className="workspace-switch" aria-label="Workspace" value={workspace} onChange={(event) => { setWorkspace(event.target.value as 'student' | 'organizer' | 'administrator'); setScreen('dashboard'); setMoreNavOpen(false); }}>{account.role === 'student' && <option value="student">Student</option>}{hasOrganizerWorkspace && <option value="organizer">Organizer</option>}{hasAdminWorkspace && <option value="administrator">Administrator</option>}</select>}<span className="local-time-pill"><span /> Africa/Nairobi</span><button className="icon-button notification-button" onClick={() => navigate('notifications')} aria-label={`${unread} unread notifications`}><Bell size={18} />{unread > 0 && <i>{unread}</i>}</button><button className="topbar-profile" onClick={() => navigate('profile')}><span className="avatar">{initials(account.displayName)}</span><ChevronDown size={14} /></button><button className="icon-button signout-button" onClick={() => void signOut()} aria-label="Sign out"><LogOut size={17} /></button></div></header>
        <div className="main-content">
          {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
          {content}
        </div>
        <footer className="app-footer"><span>CampusConnect <i>·</i> University project prototype</span><span>Fictional demo data <i>·</i> English / EAT</span></footer>
      </main>
      {toast && <div className="toast-message" role="status"><CheckCircle2 size={18} />{toast}</div>}
      {authMode && <AuthDialog initialMode={authMode} onClose={() => setAuthMode(null)} onSuccess={(nextAccount) => void handleAuth(nextAccount)} />}
    </div>
  );
}
