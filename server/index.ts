import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, loadVerifiedRoomInventory } from './db.js';
import type { Account, AccountRole, EventRecord } from './types.js';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set outside the local presentation environment.');
}

const jwtSecret = process.env.JWT_SECRET ?? 'local-only-campusconnect-secret-not-for-production';
const cookieName = 'campusconnect_session';
const app = express();

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

type AccountRow = {
  id: string;
  email: string;
  display_name: string;
  role: AccountRole;
  organizer_enabled: number;
  admin_enabled: number;
  is_active: number;
  faculty: string | null;
  course: string | null;
  registration_no: string | null;
  interests: string;
  clubs: string;
  personalization_enabled: number;
  in_app_preferences: string;
};

interface AuthenticatedRequest extends Request {
  account?: Account;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    organizerEnabled: row.organizer_enabled === 1 || row.role === 'organizer',
    adminEnabled: row.admin_enabled === 1,
    isActive: row.is_active === 1,
    faculty: row.faculty,
    course: row.course,
    registrationNo: row.registration_no,
    interests: JSON.parse(row.interests) as string[],
    clubs: JSON.parse(row.clubs) as string[],
    personalizationEnabled: row.personalization_enabled === 1,
    inAppPreferences: JSON.parse(row.in_app_preferences) as Record<string, boolean>,
  };
}

function accountById(id: string): Account | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  // Preserve Organizer access for accounts that already own real events if a
  // stale account flag was lost while the event data remained in SQLite.
  if (row && row.role === 'student' && row.organizer_enabled !== 1) {
    const ownsEvent = db.prepare('SELECT 1 FROM events WHERE organizer_id = ? AND is_demo = 0 LIMIT 1').get(id);
    if (ownsEvent) {
      db.prepare('UPDATE accounts SET organizer_enabled = 1 WHERE id = ?').run(id);
      row.organizer_enabled = 1;
    }
  }
  return row ? mapAccount(row) : undefined;
}

function issueSession(res: Response, account: Account): void {
  const token = jwt.sign({ sub: account.id }, jwtSecret, { expiresIn: '8h' });
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.cookies[cookieName] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      res.status(401).json({ error: 'Your session is invalid. Sign in again.' });
      return;
    }
    const account = accountById(payload.sub);
    if (!account || !account.isActive) {
      res.status(401).json({ error: 'Your account is unavailable. Sign in again.' });
      return;
    }
    req.account = account;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function requireRole(...roles: Array<AccountRole | 'administrator'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const allowed = req.account && (roles.includes(req.account.role)
      || (roles.includes('organizer') && req.account.organizerEnabled)
      || (roles.includes('administrator') && req.account.adminEnabled));
    if (!allowed) {
      res.status(403).json({ error: 'This action is not available for your account role.' });
      return;
    }
    next();
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function mapEvent(row: Record<string, unknown>, accountId?: string): EventRecord {
  const id = String(row.id);
  const registration = accountId
    ? db.prepare('SELECT id, status, created_at FROM registrations WHERE event_id = ? AND account_id = ?').get(id, accountId) as { id: string; status: EventRecord['currentRegistrationStatus']; created_at: string } | undefined
    : undefined;
  const position = registration?.status === 'waitlisted'
    ? (db.prepare(`
        SELECT COUNT(*) AS position FROM registrations
        WHERE event_id = ? AND status = 'waitlisted'
          AND (created_at < ? OR (created_at = ? AND id <= ?))
      `).get(id, registration.created_at, registration.created_at, registration.id) as { position: number }).position
    : null;
  return {
    id,
    title: String(row.title),
    description: String(row.description),
    category: String(row.category),
    deliveryMode: row.delivery_mode as EventRecord['deliveryMode'],
    faculty: String(row.faculty),
    clubName: row.club_name ? String(row.club_name) : null,
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    registrationClosesAt: String(row.registration_closes_at),
    expectedAttendance: Number(row.expected_attendance),
    registrationCapacity: Number(row.registration_capacity),
    requiredFacilities: parseJson<string[]>(String(row.required_facilities)),
    roomId: row.room_id ? String(row.room_id) : null,
    roomName: row.room_name ? String(row.room_name) : null,
    venueLabel: row.venue_label ? String(row.venue_label) : null,
    meetingUrl: row.meeting_url ? String(row.meeting_url) : null,
    status: row.status as EventRecord['status'],
    organizerName: String(row.organizer_name ?? ''),
    isDemo: Number(row.is_demo) === 1,
    isEventOrganizer: Boolean(accountId && row.organizer_id === accountId),
    registeredCount: Number(row.registered_count ?? 0),
    waitlistCount: Number(row.waitlist_count ?? 0),
    seatsAvailable: Math.max(0, Number(row.registration_capacity) - Number(row.registered_count ?? 0)),
    currentRegistrationStatus: registration?.status ?? null,
    currentWaitlistPosition: position,
  };
}

const eventSelect = `
  SELECT e.*, r.name AS room_name, a.display_name AS organizer_name,
    (SELECT COUNT(*) FROM registrations reg WHERE reg.event_id = e.id AND reg.status = 'registered') AS registered_count,
    (SELECT COUNT(*) FROM registrations reg WHERE reg.event_id = e.id AND reg.status = 'waitlisted') AS waitlist_count
  FROM events e
  LEFT JOIN rooms r ON r.id = e.room_id
  JOIN accounts a ON a.id = e.organizer_id
`;

function attendanceForecast(category: string, registrations: number, expectedAttendance: number, capacity: number): { estimate: number; rate: number; sampleEvents: number } {
  const history = db.prepare(`
    SELECT e.category, SUM(h.registered) AS registered, SUM(h.attended) AS attended, COUNT(*) AS samples
    FROM (
      SELECT event_id, MAX(registration_count) AS registered, MAX(check_in_count) AS attended
      FROM attendance_history GROUP BY event_id
    ) h JOIN events e ON e.id = h.event_id
    GROUP BY e.category
  `).all() as Array<{ category: string; registered: number; attended: number; samples: number }>;
  const registeredTotal = history.reduce((sum, row) => sum + row.registered, 0);
  const attendedTotal = history.reduce((sum, row) => sum + row.attended, 0);
  const globalRate = registeredTotal ? attendedTotal / registeredTotal : 0.72;
  const categoryHistory = history.find((row) => row.category === category);
  const categoryRate = categoryHistory && categoryHistory.registered
    ? categoryHistory.attended / categoryHistory.registered
    : globalRate;
  const categoryWeight = categoryHistory ? categoryHistory.registered / (categoryHistory.registered + 20) : 0;
  const rate = Math.max(0, Math.min(1, categoryRate * categoryWeight + globalRate * (1 - categoryWeight)));
  const base = registrations > 0 ? registrations : expectedAttendance;
  return {
    estimate: Math.min(capacity, Math.max(0, Math.round(base * rate))),
    rate,
    sampleEvents: categoryHistory?.samples ?? 0,
  };
}

function createNotification(accountId: string, eventId: string | null, kind: string, message: string): void {
  const account = db.prepare('SELECT in_app_preferences FROM accounts WHERE id = ?').get(accountId) as { in_app_preferences: string } | undefined;
  const preferences = account ? parseJson<Record<string, boolean>>(account.in_app_preferences) : {};
  if (preferences[kind] === false) return;
  db.prepare(`
    INSERT INTO notifications (id, account_id, event_id, kind, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), accountId, eventId, kind, message, new Date().toISOString());
}

function notifyEventRegistrants(eventId: string, kind: string, message: string): void {
  const attendees = db.prepare(`
    SELECT account_id FROM registrations WHERE event_id = ? AND status IN ('registered', 'waitlisted')
  `).all(eventId) as Array<{ account_id: string }>;
  for (const attendee of attendees) {
    createNotification(attendee.account_id, eventId, kind, message);
  }
}

function notifyStudentsAboutRecommendedEvent(eventId: string): void {
  const event = db.prepare('SELECT id, title, category, faculty, club_name, start_at FROM events WHERE id = ? AND status = ?')
    .get(eventId, 'published') as { id: string; title: string; category: string; faculty: string; club_name: string | null; start_at: string } | undefined;
  if (!event) return;
  const students = db.prepare(`SELECT id, faculty, interests, clubs FROM accounts
    WHERE role = 'student' AND is_active = 1 AND personalization_enabled = 1`).all() as Array<{ id: string; faculty: string | null; interests: string; clubs: string }>;
  const mark = db.prepare('INSERT OR IGNORE INTO notification_markers (event_id, account_id, kind, created_at) VALUES (?, ?, ?, ?)');
  for (const student of students) {
    if (student.faculty !== event.faculty
      && !parseJson<string[]>(student.interests).includes(event.category)
      && !(event.club_name && parseJson<string[]>(student.clubs).includes(event.club_name))) continue;
    const registered = db.prepare(`SELECT 1 FROM registrations WHERE event_id = ? AND account_id = ? AND status IN ('registered', 'waitlisted')`)
      .get(event.id, student.id);
    if (registered) continue;
    const marked = mark.run(event.id, student.id, 'recommendation', new Date().toISOString());
    if (marked.changes) createNotification(student.id, event.id, 'recommendation', `${event.title} is a new event you may like.`);
  }
}

const signupSchema = z.object({
  email: z.string().email().max(120).refine((value) => value.toLowerCase().endsWith('.test'), 'Use a synthetic .test email for this presentation prototype.'),
  displayName: z.string().trim().min(2).max(80),
  faculty: z.string().trim().min(1).max(120),
  course: z.string().trim().min(1).max(120),
  registrationNo: z.string().trim().min(2).max(40),
  password: z.string().min(10).max(128),
  confirmPassword: z.string().min(10).max(128),
}).refine((value) => value.password === value.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Passwords do not match.',
});

const configuredAdminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);

app.post('/api/auth/signup', (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the sign-up details.' });
    return;
  }
  const { email, displayName, faculty, course, registrationNo, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(normalizedEmail)) {
    res.status(409).json({ error: 'An account already uses that email.' });
    return;
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE registration_no = ?').get(registrationNo)) {
    res.status(409).json({ error: 'An account already uses that registration number.' });
    return;
  }

  const accountId = randomUUID();
  const createdAt = new Date().toISOString();
  const adminEnabled = configuredAdminEmails.includes(normalizedEmail) ? 1 : 0;
  const createAccount = db.transaction(() => {
    db.prepare(`
      INSERT INTO accounts (id, email, display_name, password_hash, role, faculty, course, registration_no, admin_enabled, created_at)
      VALUES (?, ?, ?, ?, 'student', ?, ?, ?, ?, ?)
    `).run(accountId, normalizedEmail, displayName, bcrypt.hashSync(password, 10), faculty, course, registrationNo, adminEnabled, createdAt);
  });
  try {
    createAccount();
  } catch {
    res.status(409).json({ error: 'The account could not be created. Check the email and invitation.' });
    return;
  }
  const account = accountById(accountId);
  if (!account) {
    res.status(500).json({ error: 'The account was created but could not be loaded.' });
    return;
  }
  issueSession(res, account);
  res.status(201).json({ account });
});

app.post('/api/auth/login', (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a valid email and password.' });
    return;
  }
  const row = db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(parsed.data.email) as (AccountRow & { password_hash: string }) | undefined;
  if (!row || !bcrypt.compareSync(parsed.data.password, row.password_hash)) {
    res.status(401).json({ error: 'Email or password is incorrect.' });
    return;
  }
  issueSession(res, mapAccount(row));
  res.json({ account: mapAccount(row) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ account: req.account });
});

function normalizeClubName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function activeClubOrganizerIds(clubKey: string): Set<string> {
  const ids = new Set((db.prepare(`
    SELECT applicant_id FROM organizer_applications
    WHERE club_key = ? AND status IN ('pending', 'approved')
  `).all(clubKey) as Array<{ applicant_id: string }>).map(({ applicant_id }) => applicant_id));
  const organizers = db.prepare("SELECT id, clubs FROM accounts WHERE role = 'organizer' OR organizer_enabled = 1")
    .all() as Array<{ id: string; clubs: string }>;
  for (const organizer of organizers) {
    const clubs = parseJson<string[]>(organizer.clubs);
    if (clubs.some((club) => normalizeClubName(club) === clubKey)) ids.add(organizer.id);
  }
  return ids;
}

app.get('/api/organizer-applications/mine', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const applications = db.prepare(`
    SELECT id, club_name AS clubName, position, reason, status, created_at AS createdAt,
      reviewed_at AS reviewedAt, review_note AS reviewNote
    FROM organizer_applications WHERE applicant_id = ? ORDER BY created_at DESC
  `).all(req.account.id);
  res.json({ applications });
});

app.post('/api/organizer-applications', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  if (req.account.organizerEnabled || req.account.adminEnabled) {
    res.status(409).json({ error: 'Your account already has Organizer access.' });
    return;
  }
  const parsed = z.object({
    clubName: z.string().trim().min(2).max(120),
    position: z.string().trim().min(2).max(100),
    reason: z.string().trim().min(20).max(1500),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the application details.' });
    return;
  }
  const clubName = parsed.data.clubName.replace(/\s+/g, ' ');
  const clubKey = normalizeClubName(clubName);
  const create = db.transaction(() => {
    const previous = db.prepare(`
      SELECT id FROM organizer_applications WHERE applicant_id = ? AND club_key = ?
        AND status IN ('pending', 'approved') LIMIT 1
    `).get(req.account?.id, clubKey);
    if (previous) return { error: 'You already have an active application for this club.' };
    const organizerIds = activeClubOrganizerIds(clubKey);
    if (organizerIds.size >= 3) return { error: 'This club already has three active Organizer applications or organizers.' };
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO organizer_applications (id, applicant_id, club_name, club_key, position, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, req.account?.id, clubName, clubKey, parsed.data.position, parsed.data.reason, createdAt);
    return { id };
  }).immediate();
  if ('error' in create) {
    res.status(409).json({ error: create.error });
    return;
  }
  res.status(201).json({ ok: true, id: create.id });
});

app.post('/api/organizer-applications/:id/withdraw', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const result = db.prepare(`
    UPDATE organizer_applications SET status = 'withdrawn'
    WHERE id = ? AND applicant_id = ? AND status = 'pending'
  `).run(req.params.id, req.account.id);
  if (result.changes !== 1) {
    res.status(409).json({ error: 'Only a pending application can be withdrawn.' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/organizer-applications/review', requireAuth, requireRole('administrator'), (_req, res) => {
  const applications = db.prepare(`
    SELECT app.id, app.club_name AS clubName, app.position, app.reason, app.created_at AS createdAt,
      account.display_name AS applicantName, account.email AS applicantEmail,
      account.faculty, account.course
    FROM organizer_applications app JOIN accounts account ON account.id = app.applicant_id
    WHERE app.status = 'pending' ORDER BY app.created_at ASC
  `).all();
  res.json({ applications });
});

app.post('/api/organizer-applications/:id/review', requireAuth, requireRole('administrator'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const parsed = z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose approve or reject and provide a valid note.' });
    return;
  }
  const review = db.transaction(() => {
    const application = db.prepare(`
      SELECT id, applicant_id, club_name, club_key, status FROM organizer_applications WHERE id = ?
    `).get(req.params.id) as { id: string; applicant_id: string; club_name: string; club_key: string; status: string } | undefined;
    if (!application || application.status !== 'pending') return { error: 'This application is no longer pending.' };
    if (application.applicant_id === req.account?.id) return { error: 'You cannot review your own application.' };
    if (parsed.data.decision === 'approve') {
      const count = activeClubOrganizerIds(application.club_key).size;
      if (count > 3) return { error: 'This club is already at the three-Organizer limit.' };
      const account = db.prepare('SELECT clubs FROM accounts WHERE id = ?').get(application.applicant_id) as { clubs: string };
      const clubs = parseJson<string[]>(account.clubs);
      if (!clubs.some((club) => normalizeClubName(club) === application.club_key)) clubs.push(application.club_name);
      db.prepare('UPDATE accounts SET organizer_enabled = 1, clubs = ? WHERE id = ?')
        .run(JSON.stringify(clubs), application.applicant_id);
    }
    db.prepare(`
      UPDATE organizer_applications SET status = ?, reviewed_at = ?, reviewer_id = ?, review_note = ?
      WHERE id = ? AND status = 'pending'
    `).run(parsed.data.decision === 'approve' ? 'approved' : 'rejected', new Date().toISOString(), req.account?.id, parsed.data.note ?? null, application.id);
    return { ok: true, applicantId: application.applicant_id, clubName: application.club_name, decision: parsed.data.decision };
  }).immediate();
  if ('error' in review) {
    res.status(409).json({ error: review.error });
    return;
  }
  const applicant = accountById(review.applicantId);
  if (applicant) createNotification(applicant.id, null, 'organizer_application',
    `Your Organizer application for ${review.clubName} was ${review.decision === 'approve' ? 'approved' : 'declined'}.`);
  res.json({ ok: true });
});

app.get('/api/events', (req: AuthenticatedRequest, res) => {
  const accountId = req.cookies[cookieName]
    ? (() => {
        try {
          const payload = jwt.verify(req.cookies[cookieName] as string, jwtSecret);
          return typeof payload === 'string' ? undefined : payload.sub;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const faculty = typeof req.query.faculty === 'string' ? req.query.faculty : '';
  const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  const currentAccount = accountId ? accountById(accountId) : undefined;
  const isOrganizer = currentAccount?.isActive === true && (currentAccount.role === 'organizer' || currentAccount.organizerEnabled || currentAccount.adminEnabled);
  let sql = `${eventSelect} WHERE e.status = 'published'`;
  const values: Array<string> = [];
  if (isOrganizer) sql = `${eventSelect} WHERE e.status IN ('published', 'draft')`;
  if (query) {
    sql += ' AND (e.title LIKE ? OR e.description LIKE ? OR e.faculty LIKE ? OR e.category LIKE ?)';
    values.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (category) {
    sql += ' AND e.category = ?';
    values.push(category);
  }
  if (faculty) {
    sql += ' AND e.faculty = ?';
    values.push(faculty);
  }
  if (mode && ['in_person', 'online', 'hybrid'].includes(mode)) {
    sql += ' AND e.delivery_mode = ?';
    values.push(mode);
  }
  if (from) {
    sql += ' AND e.start_at >= ?';
    values.push(from);
  }
  if (to) {
    sql += ' AND e.start_at <= ?';
    values.push(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to);
  }
  sql += ' ORDER BY e.start_at ASC';
  const rows = db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  res.json({ events: rows.map((row) => mapEvent(row, accountId)) });
});

app.get('/api/events/:id', (req, res) => {
  const row = db.prepare(`${eventSelect} WHERE e.id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row || row.status === 'cancelled') {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  if (row.status !== 'published') {
    const token = req.cookies[cookieName] as string | undefined;
    let account: Account | undefined;
    if (token) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        if (typeof payload !== 'string' && typeof payload.sub === 'string') account = accountById(payload.sub);
      } catch {
        account = undefined;
      }
    }
    if (!account?.isActive || (account.role !== 'organizer' && !account.organizerEnabled && !account.adminEnabled)) {
      res.status(404).json({ error: 'Event not found.' });
      return;
    }
  }
  res.json({ event: mapEvent(row) });
});

const eventInputSchema = z.object({
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(20).max(4000),
  category: z.string().trim().min(2).max(80),
  deliveryMode: z.enum(['in_person', 'online', 'hybrid']),
  faculty: z.string().trim().min(2).max(120),
  clubName: z.string().trim().max(100).optional().nullable(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  registrationClosesAt: z.string().datetime().optional(),
  expectedAttendance: z.number().int().positive().max(10000),
  registrationCapacity: z.number().int().positive().max(10000).optional(),
  requiredFacilities: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  meetingUrl: z.string().url().max(500).optional().nullable(),
});

function validateEventInput(body: unknown, res: Response): z.infer<typeof eventInputSchema> | undefined {
  const result = eventInputSchema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? 'Check the event details.' });
    return undefined;
  }
  const input = result.data;
  if (Date.parse(input.endAt) <= Date.parse(input.startAt)) {
    res.status(400).json({ error: 'The event end time must be after its start time.' });
    return undefined;
  }
  return input;
}

app.post('/api/events', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  const input = validateEventInput(req.body, res);
  if (!input || !req.account) return;
  const closesAt = input.registrationClosesAt
    ? Date.parse(input.registrationClosesAt)
    : Date.parse(input.startAt) - 24 * 60 * 60_000;
  if (Date.parse(input.startAt) <= Date.now() || closesAt <= Date.now() || closesAt >= Date.parse(input.startAt)) {
    res.status(400).json({ error: 'New events must start in the future, with registration closing before the event starts.' });
    return;
  }
  const defaultClose = new Date(Date.parse(input.startAt) - 24 * 60 * 60_000).toISOString();
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO events
      (id, title, description, category, delivery_mode, faculty, club_name, start_at, end_at,
       registration_closes_at, expected_attendance, registration_capacity, required_facilities,
       registration_capacity_custom, meeting_url, status, organizer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    id, input.title, input.description, input.category, input.deliveryMode, input.faculty, input.clubName ?? null,
    input.startAt, input.endAt, input.registrationClosesAt ?? defaultClose, input.expectedAttendance,
    input.registrationCapacity ?? input.expectedAttendance,
    JSON.stringify(input.requiredFacilities),
    Number(input.registrationCapacity !== undefined),
    input.meetingUrl ?? null,
    req.account.id, nowIso, nowIso,
  );
  const row = db.prepare(`${eventSelect} WHERE e.id = ?`).get(id) as Record<string, unknown>;
  res.status(201).json({ event: mapEvent(row) });
});

app.put('/api/events/:id', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const previous = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!previous || previous.status === 'cancelled') {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  if (previous.organizer_id !== req.account.id) {
    res.status(403).json({ error: 'Only this event’s organizer can edit it.' });
    return;
  }
  const input = validateEventInput(req.body, res);
  if (!input) return;
  const now = Date.now();
  const eventStart = Date.parse(String(previous.start_at));
  const eventEnd = Date.parse(String(previous.end_at));
  const ongoing = previous.status === 'published' && now >= eventStart && now < eventEnd;
  if (previous.status === 'published' && now >= eventEnd) {
    res.status(409).json({ error: 'This event has ended and can no longer be edited.' });
    return;
  }
  if (ongoing) {
    if (Date.parse(input.startAt) !== eventStart) {
      res.status(400).json({ error: 'The start time cannot be changed after the event has started.' });
      return;
    }
    if (Date.parse(input.endAt) < eventEnd) {
      res.status(400).json({ error: 'While an event is ongoing, you can extend its end time but cannot shorten it.' });
      return;
    }
  } else if (Date.parse(input.startAt) <= now) {
    res.status(400).json({ error: 'An event that has not started must keep a future start time.' });
    return;
  }
  const closesAt = input.registrationClosesAt
    ? Date.parse(input.registrationClosesAt)
    : Date.parse(input.startAt) - 24 * 60 * 60_000;
  const oldClosesAt = Date.parse(String(previous.registration_closes_at));
  if (ongoing) {
    if (closesAt !== oldClosesAt && closesAt <= now) {
      res.status(400).json({ error: 'A new registration closing time must be in the future.' });
      return;
    }
    if (closesAt > Date.parse(input.endAt)) {
      res.status(400).json({ error: 'Registration must close no later than the event end time.' });
      return;
    }
    if (closesAt < oldClosesAt) {
      res.status(400).json({ error: 'During an event, registration closing time can only be extended.' });
      return;
    }
  } else if (closesAt <= now || closesAt >= Date.parse(input.startAt)) {
    res.status(400).json({ error: 'Registration must close after now and before the event starts.' });
    return;
  }
  const registrationCapacity = input.registrationCapacity ?? Number(previous.registration_capacity);
  const confirmedCount = db.prepare(`
    SELECT COUNT(*) AS count FROM registrations WHERE event_id = ? AND status = 'registered'
  `).get(req.params.id) as { count: number };
  if (registrationCapacity < confirmedCount.count) {
    res.status(409).json({ error: 'Registration capacity cannot be lower than the number of confirmed students.' });
    return;
  }
  if (previous.room_id && input.deliveryMode !== 'online') {
    const room = db.prepare('SELECT capacity, facilities, buffer_minutes FROM rooms WHERE id = ? AND verified = 1').get(previous.room_id) as { capacity: number; facilities: string; buffer_minutes: number } | undefined;
    if (!room || registrationCapacity > room.capacity || input.expectedAttendance > room.capacity) {
      res.status(409).json({ error: 'Expected attendance and registration capacity must fit the confirmed room.' });
      return;
    }
    const roomFacilities = parseJson<string[]>(room.facilities);
    if (input.requiredFacilities.some((facility) => !roomFacilities.includes(facility))) {
      res.status(409).json({ error: 'The confirmed room does not have every required facility.' });
      return;
    }
    const start = Date.parse(input.startAt);
    const end = Date.parse(input.endAt);
    const otherBookings = db.prepare(`
      SELECT e.title, e.start_at, e.end_at, COALESCE(other_room.buffer_minutes, 0) AS buffer_minutes
      FROM events e LEFT JOIN rooms other_room ON other_room.id = e.room_id
      WHERE e.room_id = ? AND e.id != ? AND e.status != 'cancelled'
    `).all(previous.room_id, req.params.id) as Array<{ title: string; start_at: string; end_at: string; buffer_minutes: number }>;
    const conflict = otherBookings.find((booking) =>
      start < Date.parse(booking.end_at) + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000
        && end + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000 > Date.parse(booking.start_at),
    );
    if (conflict) {
      res.status(409).json({ error: `Room conflict: ${conflict.title} is already booked during that time.` });
      return;
    }
  }
  if (previous.status === 'published' && input.deliveryMode !== 'online' && !previous.room_id) {
    res.status(409).json({ error: 'A published in-person or hybrid event must keep a confirmed room.' });
    return;
  }
  if (previous.status === 'published' && input.deliveryMode === 'online' && !input.meetingUrl) {
    res.status(400).json({ error: 'A published Online event must keep a meeting link.' });
    return;
  }
  const nextRoomId = input.deliveryMode === 'online' ? null : previous.room_id;
  db.prepare(`
    UPDATE events SET title = ?, description = ?, category = ?, delivery_mode = ?, faculty = ?, club_name = ?,
      start_at = ?, end_at = ?, registration_closes_at = ?, expected_attendance = ?, registration_capacity = ?,
      registration_capacity_custom = ?, required_facilities = ?, meeting_url = ?, room_id = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.title, input.description, input.category, input.deliveryMode, input.faculty, input.clubName ?? null,
    input.startAt, input.endAt,
    input.registrationClosesAt ?? new Date(Date.parse(input.startAt) - 24 * 60 * 60_000).toISOString(),
    input.expectedAttendance, registrationCapacity,
    Number(input.registrationCapacity !== undefined || Number(previous.registration_capacity_custom) === 1),
    JSON.stringify(input.requiredFacilities),
    input.meetingUrl ?? null, nextRoomId, new Date().toISOString(), req.params.id,
  );
  const venueChanged = previous.room_id !== nextRoomId || previous.delivery_mode !== input.deliveryMode;
  if (venueChanged) {
    notifyEventRegistrants(String(req.params.id), 'venue_changed', `The venue or event format for ${input.title} has changed. Please review the updated details.`);
  }
  const changed = previous.title !== input.title
    || previous.start_at !== input.startAt
    || previous.end_at !== input.endAt
    || previous.registration_closes_at !== new Date(closesAt).toISOString()
    || previous.delivery_mode !== input.deliveryMode;
  if (changed) notifyEventRegistrants(String(req.params.id), 'event_changes', 'This event has important updates. Review the new details.');
  const row = db.prepare(`${eventSelect} WHERE e.id = ?`).get(req.params.id) as Record<string, unknown>;
  res.json({ event: mapEvent(row) });
});

app.post('/api/events/:id/publish', requireAuth, requireRole('organizer'), (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND status = ?').get(req.params.id, 'draft') as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Draft event not found.' });
    return;
  }
  if (row.delivery_mode === 'online' && !row.meeting_url) {
    res.status(400).json({ error: 'Add a meeting link before publishing an Online event.' });
    return;
  }
  if (row.delivery_mode !== 'online' && !row.room_id) {
    res.status(409).json({ error: 'Confirm a verified room allocation before publishing this event.' });
    return;
  }
  if (row.room_id) {
    const room = db.prepare('SELECT capacity FROM rooms WHERE id = ? AND verified = 1').get(row.room_id) as { capacity: number } | undefined;
    if (!room || Number(row.registration_capacity) > room.capacity) {
      res.status(409).json({ error: 'Registration capacity must not exceed the confirmed room capacity.' });
      return;
    }
  }
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?')
      .run('published', nowIso, req.params.id);
    db.prepare(`
      INSERT OR IGNORE INTO registrations (id, event_id, account_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'registered', ?, ?)
    `).run(randomUUID(), req.params.id, String(row.organizer_id), nowIso, nowIso);
  })();
  notifyStudentsAboutRecommendedEvent(String(req.params.id));
  res.json({ ok: true });
});

app.post('/api/events/:id/cancel', requireAuth, requireRole('organizer'), (req, res) => {
  const update = db.prepare(`
    UPDATE events SET status = 'cancelled', room_id = NULL, updated_at = ?
    WHERE id = ? AND status != 'cancelled'
  `).run(new Date().toISOString(), req.params.id);
  if (update.changes !== 1) {
    res.status(404).json({ error: 'Event not found or already cancelled.' });
    return;
  }
  notifyEventRegistrants(String(req.params.id), 'event_changes', 'This event was cancelled. Your registration has been cancelled.');
  db.prepare(`
    UPDATE registrations SET status = 'cancelled', updated_at = ?
    WHERE event_id = ? AND status IN ('registered', 'waitlisted')
  `).run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/events/:id/register', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!event || event.status !== 'published') {
    res.status(404).json({ error: 'Event is not available for registration.' });
    return;
  }
  if (Date.now() >= Date.parse(String(event.registration_closes_at))) {
    res.status(409).json({ error: 'Registration for this event has closed.' });
    return;
  }
  const previous = db.prepare('SELECT status FROM registrations WHERE event_id = ? AND account_id = ?')
    .get(req.params.id, req.account.id) as { status: string } | undefined;
  if (previous?.status === 'registered' || previous?.status === 'waitlisted') {
    res.status(409).json({ error: 'You already have an active registration for this event.' });
    return;
  }
  const register = db.transaction(() => {
    const count = db.prepare(`
      SELECT COUNT(*) AS count FROM registrations WHERE event_id = ? AND status = 'registered'
    `).get(req.params.id) as { count: number };
    const status = count.count < Number(event.registration_capacity) ? 'registered' : 'waitlisted';
    const nowIso = new Date().toISOString();
    if (previous) {
      db.prepare(`
        UPDATE registrations SET status = ?, created_at = ?, updated_at = ?
        WHERE event_id = ? AND account_id = ?
      `).run(status, nowIso, nowIso, req.params.id, req.account?.id);
    } else {
      db.prepare(`
        INSERT INTO registrations (id, event_id, account_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), req.params.id, req.account?.id, status, nowIso, nowIso);
    }
    createNotification(
      req.account?.id ?? '',
      String(req.params.id),
      'registration',
      status === 'registered' ? `You're registered for ${String(event.title)}.` : `You're on the waitlist for ${String(event.title)}.`,
    );
    return status;
  });
  const status = register();
  res.status(201).json({ status });
});

app.delete('/api/events/:id/register', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const registration = db.prepare(`
    SELECT status FROM registrations WHERE event_id = ? AND account_id = ?
  `).get(req.params.id, req.account.id) as { status: string } | undefined;
  if (!registration || !['registered', 'waitlisted'].includes(registration.status)) {
    res.status(404).json({ error: 'Active registration not found.' });
    return;
  }
  const event = db.prepare('SELECT title, start_at FROM events WHERE id = ?').get(req.params.id) as { title: string; start_at: string } | undefined;
  if (event && Date.now() >= Date.parse(event.start_at)) {
    res.status(409).json({ error: 'Registration can no longer be cancelled after the event starts.' });
    return;
  }
  const cancel = db.transaction(() => {
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE registrations SET status = 'cancelled', updated_at = ?
      WHERE event_id = ? AND account_id = ?
    `).run(nowIso, req.params.id, req.account?.id);
    if (registration.status === 'registered') {
      const next = db.prepare(`
        SELECT id, account_id FROM registrations
        WHERE event_id = ? AND status = 'waitlisted'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(req.params.id) as { id: string; account_id: string } | undefined;
      if (next && event) {
        db.prepare(`
          UPDATE registrations SET status = 'registered', updated_at = ? WHERE id = ?
        `).run(nowIso, next.id);
        createNotification(next.account_id, String(req.params.id), 'registration', `A seat opened. You're now registered for ${event.title}.`);
      }
    }
  });
  cancel();
  res.json({ ok: true });
});

const attendanceRadiusMeters = 100;
const locationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive().max(500),
});

function distanceMeters(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latDiff = radians(toLat - fromLat);
  const lonDiff = radians(toLon - fromLon);
  const a = Math.sin(latDiff / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(lonDiff / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/events/:id/attendance', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const event = db.prepare('SELECT id, status, delivery_mode, start_at, end_at, organizer_id FROM events WHERE id = ?')
    .get(req.params.id) as { id: string; status: string; delivery_mode: string; start_at: string; end_at: string; organizer_id: string } | undefined;
  if (!event || event.status === 'cancelled') {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  const session = db.prepare('SELECT opened_at, closed_at, check_in_code FROM attendance_sessions WHERE event_id = ?')
    .get(event.id) as { opened_at: string; closed_at: string | null; check_in_code: string | null } | undefined;
  const registration = req.account.role === 'student'
    ? db.prepare('SELECT status FROM registrations WHERE event_id = ? AND account_id = ?').get(event.id, req.account.id) as { status: string } | undefined
    : undefined;
  const record = req.account.role === 'student'
    ? db.prepare('SELECT checked_in_at FROM attendance_records WHERE event_id = ? AND account_id = ?').get(event.id, req.account.id) as { checked_in_at: string } | undefined
    : undefined;
  const canManage = (req.account.role === 'organizer' || req.account.organizerEnabled) && event.organizer_id === req.account.id;
  const attendees = canManage ? db.prepare(`
    SELECT display_name_snapshot AS displayName, email_snapshot AS email,
      faculty_snapshot AS faculty, course_snapshot AS course,
      registration_no_snapshot AS registrationNo, checked_in_at AS checkedInAt
    FROM attendance_records WHERE event_id = ? ORDER BY checked_in_at ASC
  `).all(event.id) : [];
  const now = Date.now();
  const ongoing = event.status === 'published' && now >= Date.parse(event.start_at) && now < Date.parse(event.end_at);
  res.json({
    session: session ? { status: session.closed_at ? 'closed' : 'open', openedAt: session.opened_at, closedAt: session.closed_at, checkInCode: canManage ? session.check_in_code : null } : { status: 'not_open', openedAt: null, closedAt: null, checkInCode: null },
    eventOngoing: ongoing,
    canManage,
    canAttend: req.account.role === 'student' && registration?.status === 'registered',
    checkedInAt: record?.checked_in_at ?? null,
    attendees,
    radiusMeters: attendanceRadiusMeters,
  });
});

app.post('/api/events/:id/attendance/open', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Share a valid current location to open attendance.' });
    return;
  }
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!event || event.status !== 'published') {
    res.status(404).json({ error: 'Published event not found.' });
    return;
  }
  if (String(event.organizer_id) !== req.account.id) {
    res.status(403).json({ error: 'Only this event’s organizer can manage attendance.' });
    return;
  }
  if (event.delivery_mode === 'online') {
    res.status(409).json({ error: 'Location-based attendance is available for in-person or hybrid events.' });
    return;
  }
  const now = Date.now();
  if (now < Date.parse(String(event.start_at)) || now >= Date.parse(String(event.end_at))) {
    res.status(409).json({ error: 'Attendance can only be opened while the event is ongoing.' });
    return;
  }
  if (parsed.data.accuracy > attendanceRadiusMeters) {
    res.status(400).json({ error: 'Your location is not precise enough. Try again outdoors or enable precise location.' });
    return;
  }
  const nowIso = new Date().toISOString();
  const checkInCode = randomBytes(12).toString('hex');
  const previousSession = db.prepare('SELECT closed_at FROM attendance_sessions WHERE event_id = ?')
    .get(req.params.id) as { closed_at: string | null } | undefined;
  if (previousSession && !previousSession.closed_at) {
    res.status(409).json({ error: 'Attendance is already open.' });
    return;
  }
  if (previousSession?.closed_at) {
    db.prepare(`UPDATE attendance_sessions SET latitude = ?, longitude = ?, opened_at = ?, closed_at = NULL, check_in_code = ?
      WHERE event_id = ? AND closed_at IS NOT NULL`)
      .run(parsed.data.latitude, parsed.data.longitude, nowIso, checkInCode, req.params.id);
    res.json({ ok: true, reopened: true });
    return;
  }
  try {
    db.prepare('INSERT INTO attendance_sessions (event_id, latitude, longitude, opened_at, check_in_code) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, parsed.data.latitude, parsed.data.longitude, nowIso, checkInCode);
  } catch {
    res.status(409).json({ error: 'Attendance has already been opened or closed for this event.' });
    return;
  }
  res.status(201).json({ ok: true });
});

app.post('/api/events/:id/attendance/close', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const event = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(req.params.id) as { organizer_id: string } | undefined;
  if (!event) {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  if (event.organizer_id !== req.account.id) {
    res.status(403).json({ error: 'Only this event’s organizer can manage attendance.' });
    return;
  }
  const nowIso = new Date().toISOString();
  const close = db.transaction(() => {
    const updated = db.prepare('UPDATE attendance_sessions SET closed_at = ? WHERE event_id = ? AND closed_at IS NULL')
      .run(nowIso, req.params.id);
    if (updated.changes !== 1) return false;
    const registered = db.prepare("SELECT COUNT(*) AS count FROM registrations WHERE event_id = ? AND status = 'registered'")
      .get(req.params.id) as { count: number };
    const checkedIn = db.prepare('SELECT COUNT(*) AS count FROM attendance_records WHERE event_id = ?')
      .get(req.params.id) as { count: number };
    db.prepare('INSERT INTO attendance_history (id, event_id, registration_count, check_in_count) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), req.params.id, registered.count, checkedIn.count);
    return true;
  });
  if (!close()) {
    res.status(409).json({ error: 'Attendance is not open.' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/events/:id/attendance/check-in', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const parsed = locationSchema.extend({ sessionCode: z.string().min(16).max(64) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Share a valid current location to check in.' });
    return;
  }
  const event = db.prepare('SELECT status, start_at, end_at, title FROM events WHERE id = ?').get(req.params.id) as { status: string; start_at: string; end_at: string; title: string } | undefined;
  if (!event || event.status !== 'published') {
    res.status(404).json({ error: 'Published event not found.' });
    return;
  }
  const now = Date.now();
  if (now < Date.parse(event.start_at) || now >= Date.parse(event.end_at)) {
    res.status(409).json({ error: 'Attendance can only be marked while the event is ongoing.' });
    return;
  }
  const registration = db.prepare("SELECT status FROM registrations WHERE event_id = ? AND account_id = ?")
    .get(req.params.id, req.account.id) as { status: string } | undefined;
  if (registration?.status !== 'registered') {
    res.status(403).json({ error: 'Only students with a confirmed registration can check in.' });
    return;
  }
  const session = db.prepare('SELECT latitude, longitude, closed_at, check_in_code FROM attendance_sessions WHERE event_id = ?')
    .get(req.params.id) as { latitude: number; longitude: number; closed_at: string | null; check_in_code: string | null } | undefined;
  if (!session || session.closed_at) {
    res.status(409).json({ error: 'The organizer has not opened attendance or has closed it.' });
    return;
  }
  if (!session.check_in_code || parsed.data.sessionCode !== session.check_in_code) {
    res.status(403).json({ error: 'Scan the current attendance QR code shown by the organizer.' });
    return;
  }
  if (parsed.data.accuracy > 150) {
    res.status(400).json({ error: 'Your location is not precise enough. Enable precise location and try again.' });
    return;
  }
  const distance = distanceMeters(session.latitude, session.longitude, parsed.data.latitude, parsed.data.longitude);
  if (distance > attendanceRadiusMeters) {
    res.status(403).json({ error: `You must be within ${attendanceRadiusMeters} metres of the event location to check in.` });
    return;
  }
  try {
    db.prepare(`
      INSERT INTO attendance_records
        (id, event_id, account_id, display_name_snapshot, email_snapshot, faculty_snapshot, course_snapshot, registration_no_snapshot, checked_in_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), req.params.id, req.account.id,
      req.account.displayName, req.account.email, req.account.faculty, req.account.course, req.account.registrationNo,
      new Date().toISOString(),
    );
  } catch {
    res.status(409).json({ error: 'You have already checked in to this event.' });
    return;
  }
  createNotification(req.account.id, String(req.params.id), 'attendance_confirmed', `Your attendance for ${event.title} is confirmed.`);
  res.status(201).json({ ok: true });
});

const adminRoomSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().positive().max(10000),
  facilities: z.array(z.string().trim().min(1).max(80)).max(40),
  bufferMinutes: z.number().int().nonnegative().max(1440),
  verified: z.boolean(),
});

app.get('/api/admin/users', requireAuth, requireRole('administrator'), (_req, res) => {
  const users = db.prepare(`
    SELECT id, email, display_name AS displayName, role, faculty, course, registration_no AS registrationNo,
      organizer_enabled AS organizerEnabled, admin_enabled AS adminEnabled,
      is_active AS isActive, created_at AS createdAt
    FROM accounts ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

app.patch('/api/admin/users/:id', requireAuth, requireRole('administrator'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose whether the account should be active.' });
    return;
  }
  if (req.params.id === req.account.id && !parsed.data.isActive) {
    res.status(409).json({ error: 'You cannot deactivate your own administrator account.' });
    return;
  }
  const target = db.prepare('SELECT admin_enabled FROM accounts WHERE id = ?').get(req.params.id) as { admin_enabled: number } | undefined;
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  if (target.admin_enabled === 1 && !parsed.data.isActive) {
    const activeAdmins = db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE admin_enabled = 1 AND is_active = 1').get() as { count: number };
    if (activeAdmins.count <= 1) {
      res.status(409).json({ error: 'At least one active administrator must remain.' });
      return;
    }
  }
  db.prepare('UPDATE accounts SET is_active = ? WHERE id = ?').run(Number(parsed.data.isActive), req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/rooms', requireAuth, requireRole('administrator'), (_req, res) => {
  const rooms = db.prepare('SELECT id, code, name, capacity, facilities, buffer_minutes AS bufferMinutes, verified FROM rooms ORDER BY name')
    .all() as Array<{ id: string; code: string; name: string; capacity: number; facilities: string; bufferMinutes: number; verified: number }>;
  res.json({ rooms: rooms.map((room) => ({ ...room, facilities: parseJson<string[]>(room.facilities), bufferMinutes: room.bufferMinutes, verified: room.verified === 1 })) });
});

app.post('/api/admin/rooms', requireAuth, requireRole('administrator'), (req, res) => {
  const parsed = adminRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the room details.' });
    return;
  }
  try {
    db.prepare(`INSERT INTO rooms (id, code, name, capacity, facilities, buffer_minutes, verified) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), parsed.data.code, parsed.data.name, parsed.data.capacity, JSON.stringify(parsed.data.facilities), parsed.data.bufferMinutes, Number(parsed.data.verified));
  } catch {
    res.status(409).json({ error: 'A room with that code already exists.' });
    return;
  }
  res.status(201).json({ ok: true });
});

app.put('/api/admin/rooms/:id', requireAuth, requireRole('administrator'), (req, res) => {
  const parsed = adminRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the room details.' });
    return;
  }
  const room = db.prepare('SELECT id, code, name FROM rooms WHERE id = ?').get(req.params.id) as { id: string; code: string; name: string } | undefined;
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }
  const bookings = db.prepare('SELECT expected_attendance, registration_capacity, required_facilities FROM events WHERE room_id = ? AND status != ?')
    .all(req.params.id, 'cancelled') as Array<{ expected_attendance: number; registration_capacity: number; required_facilities: string }>;
  if (!parsed.data.verified && bookings.length > 0) {
    res.status(409).json({ error: 'A room with active event bookings cannot be marked unverified.' });
    return;
  }
  const missing = bookings.some((event) => Number(event.expected_attendance) > parsed.data.capacity
    || Number(event.registration_capacity) > parsed.data.capacity
    || parseJson<string[]>(event.required_facilities).some((facility) => !parsed.data.facilities.includes(facility)));
  if (missing) {
    res.status(409).json({ error: 'Room changes would make an existing event booking invalid.' });
    return;
  }
  try {
    db.prepare(`UPDATE rooms SET code = ?, name = ?, capacity = ?, facilities = ?, buffer_minutes = ?, verified = ? WHERE id = ?`)
      .run(parsed.data.code, parsed.data.name, parsed.data.capacity, JSON.stringify(parsed.data.facilities), parsed.data.bufferMinutes, Number(parsed.data.verified), req.params.id);
  } catch {
    res.status(409).json({ error: 'A room with that code already exists.' });
    return;
  }
  if (room.name !== parsed.data.name || room.code !== parsed.data.code) {
    const affected = db.prepare(`SELECT id, title FROM events WHERE room_id = ? AND status = 'published'`).all(req.params.id) as Array<{ id: string; title: string }>;
    for (const event of affected) {
      notifyEventRegistrants(event.id, 'venue_changed', `${event.title} venue has changed to ${parsed.data.name} (${parsed.data.code}).`);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:id', requireAuth, requireRole('administrator'), (req, res) => {
  const booking = db.prepare('SELECT 1 FROM events WHERE room_id = ? AND status != ? LIMIT 1').get(req.params.id, 'cancelled');
  if (booking) {
    res.status(409).json({ error: 'This room is assigned to an event. Reallocate or cancel the event before removing it.' });
    return;
  }
  const removed = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  if (removed.changes !== 1) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/rooms', (_req, res) => {
  const rooms = db.prepare(`
    SELECT id, code, name, capacity, facilities, buffer_minutes
    FROM rooms WHERE verified = 1 ORDER BY name
  `).all() as Array<{ id: string; code: string; name: string; capacity: number; facilities: string; buffer_minutes: number }>;
  res.json({
    configured: rooms.length > 0,
    rooms: rooms.map((room) => ({ ...room, facilities: parseJson<string[]>(room.facilities), bufferMinutes: room.buffer_minutes })),
  });
});

app.get('/api/events/:id/room-options', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND status != ?').get(req.params.id, 'cancelled') as Record<string, unknown> | undefined;
  if (!event || event.organizer_id !== req.account.id) {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  const rooms = db.prepare(`
    SELECT * FROM rooms WHERE verified = 1 ORDER BY capacity ASC
  `).all() as Array<{ id: string; code: string; name: string; capacity: number; facilities: string; buffer_minutes: number }>;
  if (!rooms.length) {
    res.json({ configured: false, attendanceEstimate: 0, recommendations: [], conflicts: [], eventOverlaps: [] });
    return;
  }
  const required = parseJson<string[]>(String(event.required_facilities));
  const start = Date.parse(String(event.start_at));
  const end = Date.parse(String(event.end_at));
  const attendanceEstimate = attendanceForecast(String(event.category), 0, Number(event.expected_attendance), Number(event.registration_capacity)).estimate;
  const eventOverlaps = db.prepare(`
    SELECT id AS eventId, title AS eventTitle, start_at AS startAt, end_at AS endAt, room_id AS roomId
    FROM events
    WHERE id != ? AND status != 'cancelled'
      AND start_at < ? AND end_at > ?
      AND (organizer_id = ? OR (club_name IS NOT NULL AND club_name = ?))
    ORDER BY start_at ASC
  `).all(req.params.id, String(event.end_at), String(event.start_at), req.account.id, event.club_name ?? '') as Array<{ eventId: string; eventTitle: string; startAt: string; endAt: string; roomId: string | null }>;
  const recommendations = rooms.map((room) => {
    const facilities = parseJson<string[]>(room.facilities);
    const missing = required.filter((facility) => !facilities.includes(facility));
    const overlap = db.prepare(`
      SELECT e.id, e.title, e.start_at, e.end_at, COALESCE(booked_room.buffer_minutes, 0) AS buffer_minutes
      FROM events e
      LEFT JOIN rooms booked_room ON booked_room.id = e.room_id
      WHERE e.room_id = ? AND e.id != ? AND e.status != 'cancelled'
    `).all(room.id, req.params.id) as Array<{ id: string; title: string; start_at: string; end_at: string; buffer_minutes: number }>;
    const conflict = overlap.find((booking) =>
      start < Date.parse(booking.end_at) + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000
        && end + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000 > Date.parse(booking.start_at),
    );
    const neededCapacity = Math.max(Number(event.expected_attendance), Number(event.registration_capacity));
    const eligible = room.capacity >= neededCapacity && missing.length === 0 && !conflict;
    const utilization = attendanceEstimate / room.capacity;
    const capacityScore = Math.max(0, 100 - Math.abs(utilization - 0.72) * 100);
    const facilityScore = required.length ? Math.min(100, 82 + Math.max(0, facilities.length - required.length) * 4) : 82;
    const availabilityScore = conflict ? 0 : 100;
    const recommendationScore = Math.round(capacityScore * 0.55 + facilityScore * 0.25 + availabilityScore * 0.2);
    return {
      roomId: room.id,
      code: room.code,
      name: room.name,
      capacity: room.capacity,
      facilities,
      missingFacilities: missing,
      attendanceEstimate,
      capacityFitScore: Math.round(utilization * 100),
      recommendationScore,
      conflict: conflict ? { eventId: conflict.id, eventTitle: conflict.title, startAt: conflict.start_at, endAt: conflict.end_at } : null,
      eligible,
      reasons: [
        room.capacity >= neededCapacity ? `Fits ${neededCapacity} seats` : `Needs ${neededCapacity} seats`,
        missing.length ? `Missing: ${missing.join(', ')}` : 'Required facilities available',
        conflict ? `Conflicts with ${conflict.title}` : 'Available at this time',
        `${recommendationScore}% overall fit`,
      ],
    };
  });
  recommendations.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.recommendationScore - a.recommendationScore);
  res.json({
    configured: true,
    attendanceEstimate,
    recommendations,
    conflicts: recommendations.filter((room) => room.conflict).map((room) => room.conflict),
    eventOverlaps,
  });
});

app.post('/api/events/:id/room', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const parsed = z.object({ roomId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose a valid room.' });
    return;
  }
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND status = ?').get(req.params.id, 'draft') as Record<string, unknown> | undefined;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND verified = 1').get(parsed.data.roomId) as { id: string; capacity: number; facilities: string; buffer_minutes: number } | undefined;
  if (!event || !room) {
    res.status(404).json({ error: 'Draft event or verified room not found.' });
    return;
  }
  if (event.organizer_id !== req.account.id) {
    res.status(403).json({ error: 'Only this event’s organizer can confirm its room.' });
    return;
  }
  const required = parseJson<string[]>(String(event.required_facilities));
  const availableFacilities = parseJson<string[]>(room.facilities);
  if (room.capacity < Number(event.expected_attendance) || required.some((item) => !availableFacilities.includes(item))) {
    res.status(409).json({ error: 'This room does not meet the event capacity and facility requirements.' });
    return;
  }
  const customCapacity = Number(event.registration_capacity_custom) === 1;
  if (customCapacity && Number(event.registration_capacity) > room.capacity) {
    res.status(409).json({ error: 'Registration capacity cannot exceed the confirmed room capacity.' });
    return;
  }
  const start = Date.parse(String(event.start_at));
  const end = Date.parse(String(event.end_at));
  const conflict = db.prepare(`
    SELECT e.title, e.start_at, e.end_at, COALESCE(booked_room.buffer_minutes, 0) AS buffer_minutes FROM events e
    LEFT JOIN rooms booked_room ON booked_room.id = e.room_id
    WHERE e.room_id = ? AND e.id != ? AND e.status != 'cancelled'
  `).all(room.id, req.params.id) as Array<{ title: string; start_at: string; end_at: string; buffer_minutes: number }>;
  const collision = conflict.find((booking) =>
    start < Date.parse(booking.end_at) + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000
      && end + Math.max(room.buffer_minutes, booking.buffer_minutes) * 60_000 > Date.parse(booking.start_at),
  );
  if (collision) {
    res.status(409).json({ error: `Room conflict: ${collision.title} is already booked during that time.` });
    return;
  }
  db.prepare(`
    UPDATE events SET room_id = ?, registration_capacity = ?, updated_at = ? WHERE id = ?
  `).run(
    room.id,
    customCapacity ? Number(event.registration_capacity) : room.capacity,
    new Date().toISOString(),
    req.params.id,
  );
  res.json({ ok: true });
});

app.get('/api/recommendations', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.account.id) as AccountRow;
  if (account.personalization_enabled !== 1) {
    res.json({ personalizationEnabled: false, recommendations: [] });
    return;
  }
  const rows = db.prepare(`
    ${eventSelect}
    WHERE e.status = 'published'
      AND e.start_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM registrations r
        WHERE r.event_id = e.id AND r.account_id = ? AND r.status IN ('registered', 'waitlisted')
      )
    ORDER BY e.start_at ASC
  `).all(new Date().toISOString(), req.account.id) as Array<Record<string, unknown>>;
  const interests = parseJson<string[]>(account.interests);
  const clubs = parseJson<string[]>(account.clubs);
  const attendance = db.prepare(`
    SELECT DISTINCT e.category FROM attendance_history ah
    JOIN events e ON e.id = ah.event_id
    WHERE ah.check_in_count > 0 AND e.faculty = ?
  `).all(account.faculty) as Array<{ category: string }>;
  const attendedCategories = new Set(attendance.map((item) => item.category));
  const recommendations = rows.map((row) => {
    const reasons: string[] = [];
    let score = 0;
    if (interests.includes(String(row.category))) {
      score += 25;
      reasons.push(`Matches your interest in ${String(row.category)}`);
    }
    if (account.faculty && row.faculty === account.faculty) {
      score += 25;
      reasons.push(`Relevant to ${account.faculty}`);
    }
    if (row.club_name && clubs.includes(String(row.club_name))) {
      score += 25;
      reasons.push(`Connected to ${String(row.club_name)}`);
    }
    if (attendedCategories.has(String(row.category))) {
      score += 25;
      reasons.push('Similar to events you have attended');
    }
    return { event: mapEvent(row, req.account?.id), score, reasons };
  }).sort((a, b) => b.score - a.score || Date.parse(a.event.startAt) - Date.parse(b.event.startAt));
  res.json({ personalizationEnabled: true, recommendations });
});

app.get('/api/calendar', requireAuth, requireRole('student'), (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const rows = db.prepare(`
    ${eventSelect}
    WHERE e.status = 'published' AND e.start_at >= ? AND EXISTS (
      SELECT 1 FROM registrations r
      WHERE r.event_id = e.id AND r.account_id = ? AND r.status = 'registered'
    )
    ORDER BY e.start_at ASC
  `).all(new Date().toISOString(), req.account.id) as Array<Record<string, unknown>>;
  res.json({ events: rows.map((row) => mapEvent(row, req.account?.id)) });
});

app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const notifications = db.prepare(`
    SELECT id, event_id AS eventId, kind, message, created_at AS createdAt, read_at AS readAt
    FROM notifications WHERE account_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.account.id);
  res.json({ notifications });
});

app.patch('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const result = db.prepare(`
    UPDATE notifications SET read_at = ?
    WHERE id = ? AND account_id = ?
  `).run(new Date().toISOString(), req.params.id, req.account.id);
  if (!result.changes) {
    res.status(404).json({ error: 'Notification not found.' });
    return;
  }
  res.json({ ok: true });
});

app.patch('/api/me/profile', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.account) return;
  const schema = z.object({
    faculty: z.string().trim().max(120).nullable().optional(),
    course: z.string().trim().max(120).nullable().optional(),
    registrationNo: z.string().trim().min(2).max(40).nullable().optional(),
    interests: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    clubs: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    personalizationEnabled: z.boolean().optional(),
    inAppPreferences: z.record(z.string(), z.boolean()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the profile details.' });
    return;
  }
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.account.id) as AccountRow;
  const input = parsed.data;
  if (input.registrationNo && db.prepare('SELECT 1 FROM accounts WHERE registration_no = ? AND id != ?').get(input.registrationNo, req.account.id)) {
    res.status(409).json({ error: 'An account already uses that registration number.' });
    return;
  }
  db.prepare(`
    UPDATE accounts SET faculty = ?, course = ?, registration_no = ?, interests = ?, clubs = ?, personalization_enabled = ?, in_app_preferences = ?
    WHERE id = ?
  `).run(
    input.faculty === undefined ? existing.faculty : input.faculty,
    input.course === undefined ? existing.course : input.course,
    input.registrationNo === undefined ? existing.registration_no : input.registrationNo,
    JSON.stringify(input.interests ?? parseJson<string[]>(existing.interests)),
    JSON.stringify(input.clubs ?? parseJson<string[]>(existing.clubs)),
    input.personalizationEnabled === undefined ? existing.personalization_enabled : Number(input.personalizationEnabled),
    JSON.stringify(input.inAppPreferences ?? parseJson<Record<string, boolean>>(existing.in_app_preferences)),
    req.account.id,
  );
  const account = accountById(req.account.id);
  if (!account) {
    res.status(500).json({ error: 'Profile could not be reloaded.' });
    return;
  }
  res.json({ account });
});

app.get('/api/organizer/attendance-analytics', requireAuth, requireRole('organizer', 'administrator'), (_req, res) => {
  const totalAttendance = (db.prepare(`
    SELECT COUNT(*) AS count FROM attendance_records a
    JOIN events e ON e.id = a.event_id WHERE e.status = 'published'
  `).get() as { count: number }).count;
  const confirmedRegistrations = (db.prepare(`
    SELECT COUNT(*) AS count FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE e.status = 'published' AND r.status = 'registered'
  `).get() as { count: number }).count;
  const participation = db.prepare(`
    SELECT COUNT(DISTINCT a.account_id) AS participants,
      (SELECT COUNT(*) FROM accounts WHERE role = 'student' AND is_active = 1) AS students
    FROM attendance_records a JOIN events e ON e.id = a.event_id
    WHERE e.status = 'published'
  `).get() as { participants: number; students: number };
  const facultyRows = db.prepare(`
    SELECT COALESCE(NULLIF(a.faculty_snapshot, ''), 'Faculty not provided') AS faculty,
      COUNT(*) AS count
    FROM attendance_records a JOIN events e ON e.id = a.event_id
    WHERE e.status = 'published'
    GROUP BY faculty ORDER BY count DESC, faculty ASC LIMIT 8
  `).all() as Array<{ faculty: string; count: number }>;
  const recentTrendRows = db.prepare(`
    SELECT substr(a.checked_in_at, 1, 10) AS day, COUNT(*) AS count
    FROM attendance_records a JOIN events e ON e.id = a.event_id
    WHERE e.status = 'published' AND a.checked_in_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString()) as Array<{ day: string; count: number }>;
  const popularEvents = db.prepare(`
    SELECT e.id, e.title,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registrations,
      (SELECT COUNT(*) FROM attendance_records a WHERE a.event_id = e.id) AS attendance
    FROM events e WHERE e.status = 'published'
    ORDER BY registrations DESC, attendance DESC, e.start_at DESC LIMIT 6
  `).all() as Array<{ id: string; title: string; registrations: number; attendance: number }>;
  const activeFaculty = facultyRows[0]?.faculty ?? 'No attendance yet';
  res.json({
    kpis: {
      totalAttendance,
      attendancePercentage: confirmedRegistrations ? Math.min(100, Math.round(totalAttendance / confirmedRegistrations * 100)) : 0,
      mostActiveFaculty: activeFaculty,
      mostPopularEvent: popularEvents[0]?.title ?? 'No registrations yet',
    },
    registrationDenominator: confirmedRegistrations,
    studentParticipation: {
      participants: participation.participants,
      students: participation.students,
      rate: participation.students ? Math.round(participation.participants / participation.students * 100) : 0,
    },
    attendanceTrends: recentTrendRows,
    attendancePerFaculty: facultyRows,
    popularEvents,
  });
});

app.get('/api/organizer/analytics', requireAuth, requireRole('organizer', 'administrator'), (_req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) AS totalEvents,
      SUM(CASE WHEN status = 'published' AND start_at > ? THEN 1 ELSE 0 END) AS upcomingEvents,
      SUM(CASE WHEN status = 'published' THEN
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = events.id AND r.status = 'registered')
        ELSE 0 END) AS registeredStudents
    FROM events WHERE status != 'cancelled'
  `).get(new Date().toISOString()) as { totalEvents: number; upcomingEvents: number; registeredStudents: number };
  const categoryRows = db.prepare(`
    SELECT category, COUNT(*) AS count FROM events
    WHERE status = 'published' GROUP BY category ORDER BY count DESC
  `).all();
  const trendRows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
    FROM registrations WHERE status IN ('registered', 'waitlisted')
    GROUP BY day ORDER BY day DESC LIMIT 7
  `).all();
  const history = db.prepare(`
    SELECT COALESCE(SUM(check_in_count), 0) AS attended,
      COALESCE(SUM(registration_count), 0) AS registered,
      COUNT(*) AS samples FROM attendance_history
  `).get() as { attended: number; registered: number; samples: number };
  const turnoutRate = history.registered > 0 ? history.attended / history.registered : 0;
  const predictionRows = db.prepare(`
    ${eventSelect}
    WHERE e.status = 'published' AND e.start_at > ?
    ORDER BY e.start_at ASC LIMIT 8
  `).all(new Date().toISOString()) as Array<Record<string, unknown>>;
  const predictions = predictionRows.map((row) => {
    const event = mapEvent(row);
    const forecast = attendanceForecast(event.category, event.registeredCount, event.expectedAttendance, event.registrationCapacity);
    const margin = Math.max(3, Math.round(forecast.estimate * (forecast.sampleEvents >= 3 ? 0.15 : 0.3)));
    return { event, estimate: forecast.estimate, attendanceRate: Math.round(forecast.rate * 100), lowerBound: Math.max(0, forecast.estimate - margin), upperBound: Math.min(event.registrationCapacity, forecast.estimate + margin), historySamples: forecast.sampleEvents };
  });
  const rooms = db.prepare('SELECT COUNT(*) AS total FROM rooms WHERE verified = 1').get() as { total: number };
  const bookedRooms = db.prepare(`
    SELECT COUNT(DISTINCT room_id) AS count FROM events
    WHERE room_id IS NOT NULL AND status = 'published' AND end_at > ?
  `).get(new Date().toISOString()) as { count: number };
  res.json({
    totals: {
      totalEvents: totals.totalEvents ?? 0,
      upcomingEvents: totals.upcomingEvents ?? 0,
      registeredStudents: totals.registeredStudents ?? 0,
      attendanceRate: Math.round(turnoutRate * 100),
    },
    categories: categoryRows,
    registrationTrend: trendRows.reverse(),
    predictions,
    roomUtilization: { configuredRooms: rooms.total, currentlyBookedRooms: bookedRooms.count },
    predictionMethod: 'Confirmed registrations multiplied by a smoothed event-category attendance rate, with campus-wide history as a fallback.',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

function deliverScheduledInAppNotifications(): void {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 24 * 60 * 60_000));
  const tomorrowRows = db.prepare(`
    SELECT e.id AS event_id, e.title, r.account_id, e.start_at
    FROM events e JOIN registrations r ON r.event_id = e.id
    WHERE e.status = 'published' AND r.status = 'registered'
      AND e.start_at > ? AND e.start_at <= ?
  `).all(nowIso, new Date(now.getTime() + 48 * 60 * 60_000).toISOString()) as Array<{ event_id: string; title: string; account_id: string; start_at: string }>;
  const reminderRows = tomorrowRows.filter((row) => dayKey(new Date(row.start_at)) === tomorrow);
  const closingTodayRows = db.prepare(`
    SELECT e.id AS event_id, e.title, r.account_id, e.registration_closes_at
    FROM events e JOIN registrations r ON r.event_id = e.id
    WHERE e.status = 'published' AND r.status IN ('registered', 'waitlisted')
      AND e.registration_closes_at > ? AND e.registration_closes_at <= ?
  `).all(nowIso, new Date(now.getTime() + 48 * 60 * 60_000).toISOString()) as Array<{ event_id: string; title: string; account_id: string; registration_closes_at: string }>;
  const dueTodayRows = closingTodayRows.filter((row) => dayKey(new Date(row.registration_closes_at)) === today);
  const insertMarker = db.prepare(`
    INSERT OR IGNORE INTO notification_markers (event_id, account_id, kind, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const sendOnce = db.transaction((rows: Array<{ event_id: string; title: string; account_id: string }>, kind: string, message: (title: string) => string) => {
    for (const row of rows) {
      const marker = insertMarker.run(row.event_id, row.account_id, kind, nowIso);
      if (marker.changes === 1) createNotification(row.account_id, row.event_id, kind, message(row.title));
    }
  });
  sendOnce(reminderRows, 'event_reminder', (title) => `${title} is happening tomorrow.`);
  sendOnce(dueTodayRows, 'registration_close', (title) => `Registration for ${title} closes today.`);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

loadVerifiedRoomInventory();
if (process.env.NODE_ENV !== 'test') {
  deliverScheduledInAppNotifications();
  setInterval(deliverScheduledInAppNotifications, 30_000);
}

export { app };

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.API_PORT ?? 3001);
  app.listen(port, '127.0.0.1', () => {
    console.log(`CampusConnect API listening on http://127.0.0.1:${port}`);
  });
}
