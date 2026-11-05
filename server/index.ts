import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
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
  faculty: string | null;
  course: string | null;
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
    faculty: row.faculty,
    course: row.course,
    interests: JSON.parse(row.interests) as string[],
    clubs: JSON.parse(row.clubs) as string[],
    personalizationEnabled: row.personalization_enabled === 1,
    inAppPreferences: JSON.parse(row.in_app_preferences) as Record<string, boolean>,
  };
}

function accountById(id: string): Account | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
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
    if (!account) {
      res.status(401).json({ error: 'Your account is unavailable. Sign in again.' });
      return;
    }
    req.account = account;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function requireRole(...roles: AccountRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.account || !roles.includes(req.account.role)) {
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
    meetingUrl: row.meeting_url ? String(row.meeting_url) : null,
    status: row.status as EventRecord['status'],
    organizerName: String(row.organizer_name ?? ''),
    isDemo: Number(row.is_demo) === 1,
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

function createNotification(accountId: string, eventId: string, kind: string, message: string): void {
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

const signupSchema = z.object({
  email: z.string().email().max(120).refine((value) => value.toLowerCase().endsWith('.test'), 'Use a synthetic .test email for this presentation prototype.'),
  displayName: z.string().trim().min(2).max(80),
  password: z.string().min(10).max(128),
  invitationCode: z.string().trim().max(120).optional(),
});

app.post('/api/auth/signup', (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the sign-up details.' });
    return;
  }
  const { email, displayName, password, invitationCode } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const role: AccountRole = invitationCode ? 'organizer' : 'student';
  const invitationHash = invitationCode ? createHash('sha256').update(invitationCode).digest('hex') : null;
  const invitation = invitationHash
    ? db.prepare('SELECT id, used_at, expires_at FROM organizer_invitations WHERE code_hash = ?').get(invitationHash) as { id: string; used_at: string | null; expires_at: string | null } | undefined
    : undefined;

  if (invitationCode && (!invitation || invitation.used_at || (invitation.expires_at && Date.parse(invitation.expires_at) < Date.now()))) {
    res.status(400).json({ error: 'That Organizer invitation is invalid, expired, or already used.' });
    return;
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(normalizedEmail)) {
    res.status(409).json({ error: 'An account already uses that email.' });
    return;
  }

  const accountId = randomUUID();
  const createdAt = new Date().toISOString();
  const createAccount = db.transaction(() => {
    db.prepare(`
      INSERT INTO accounts (id, email, display_name, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(accountId, normalizedEmail, displayName, bcrypt.hashSync(password, 10), role, createdAt);
    if (invitation) {
      const result = db.prepare(`
        UPDATE organizer_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL
      `).run(createdAt, invitation.id);
      if (result.changes !== 1) throw new Error('Organizer invitation was already redeemed.');
    }
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

app.post('/api/auth/redeem-invitation', requireAuth, (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ code: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success || !req.account) {
    res.status(400).json({ error: 'Enter a valid invitation code.' });
    return;
  }
  const hash = createHash('sha256').update(parsed.data.code).digest('hex');
  const invitation = db.prepare('SELECT id, used_at, expires_at FROM organizer_invitations WHERE code_hash = ?').get(hash) as { id: string; used_at: string | null; expires_at: string | null } | undefined;
  if (!invitation || invitation.used_at || (invitation.expires_at && Date.parse(invitation.expires_at) < Date.now())) {
    res.status(400).json({ error: 'That Organizer invitation is invalid, expired, or already used.' });
    return;
  }
  const redeem = db.transaction(() => {
    const result = db.prepare('UPDATE organizer_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(new Date().toISOString(), invitation.id);
    if (result.changes !== 1) throw new Error('Invitation was already used.');
    db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run('organizer', req.account?.id);
  });
  try {
    redeem();
  } catch {
    res.status(409).json({ error: 'That Organizer invitation was already redeemed.' });
    return;
  }
  const account = accountById(req.account.id);
  if (!account) {
    res.status(500).json({ error: 'The account could not be reloaded.' });
    return;
  }
  issueSession(res, account);
  res.json({ account });
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
  const isOrganizer = accountId ? accountById(accountId)?.role === 'organizer' : false;
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
    let role: AccountRole | undefined;
    if (token) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        if (typeof payload !== 'string' && typeof payload.sub === 'string') role = accountById(payload.sub)?.role;
      } catch {
        role = undefined;
      }
    }
    if (role !== 'organizer') {
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
  if (Date.parse(input.startAt) <= Date.now()) {
    res.status(400).json({ error: 'New events must start in the future.' });
    return undefined;
  }
  const closesAt = input.registrationClosesAt
    ? Date.parse(input.registrationClosesAt)
    : Date.parse(input.startAt) - 24 * 60 * 60_000;
  if (closesAt <= Date.now() || closesAt >= Date.parse(input.startAt)) {
    res.status(400).json({ error: 'Registration must close after now and before the event starts.' });
    return undefined;
  }
  return input;
}

app.post('/api/events', requireAuth, requireRole('organizer'), (req: AuthenticatedRequest, res) => {
  const input = validateEventInput(req.body, res);
  if (!input || !req.account) return;
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

app.put('/api/events/:id', requireAuth, requireRole('organizer'), (req, res) => {
  const input = validateEventInput(req.body, res);
  if (!input) return;
  const existing = db.prepare('SELECT status FROM events WHERE id = ?').get(req.params.id) as { status: string } | undefined;
  if (!existing || existing.status === 'cancelled') {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  const previous = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id) as Record<string, unknown>;
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
      SELECT title, start_at, end_at FROM events
      WHERE room_id = ? AND id != ? AND status != 'cancelled'
    `).all(previous.room_id, req.params.id) as Array<{ title: string; start_at: string; end_at: string }>;
    const buffer = room.buffer_minutes * 60_000;
    const conflict = otherBookings.find((booking) =>
      start < Date.parse(booking.end_at) + buffer && end + buffer > Date.parse(booking.start_at),
    );
    if (conflict) {
      res.status(409).json({ error: `Room conflict: ${conflict.title} is already booked during that time.` });
      return;
    }
  }
  if (existing.status === 'published' && input.deliveryMode !== 'online' && !previous.room_id) {
    res.status(409).json({ error: 'A published in-person or hybrid event must keep a confirmed room.' });
    return;
  }
  if (existing.status === 'published' && input.deliveryMode === 'online' && !input.meetingUrl) {
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
  const changed = previous.title !== input.title
    || previous.start_at !== input.startAt
    || previous.end_at !== input.endAt
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
  db.prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?')
    .run('published', new Date().toISOString(), req.params.id);
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

app.get('/api/events/:id/room-options', requireAuth, requireRole('organizer'), (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND status != ?').get(req.params.id, 'cancelled') as Record<string, unknown> | undefined;
  if (!event) {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  const rooms = db.prepare(`
    SELECT * FROM rooms WHERE verified = 1 ORDER BY capacity ASC
  `).all() as Array<{ id: string; code: string; name: string; capacity: number; facilities: string; buffer_minutes: number }>;
  if (!rooms.length) {
    res.json({ configured: false, recommendations: [], conflicts: [] });
    return;
  }
  const required = parseJson<string[]>(String(event.required_facilities));
  const start = Date.parse(String(event.start_at));
  const end = Date.parse(String(event.end_at));
  const recommendations = rooms.map((room) => {
    const facilities = parseJson<string[]>(room.facilities);
    const missing = required.filter((facility) => !facilities.includes(facility));
    const overlap = db.prepare(`
      SELECT e.id, e.title, e.start_at, e.end_at
      FROM events e
      WHERE e.room_id = ? AND e.id != ? AND e.status != 'cancelled'
    `).all(room.id, req.params.id) as Array<{ id: string; title: string; start_at: string; end_at: string }>;
    const buffer = room.buffer_minutes * 60_000;
    const conflict = overlap.find((booking) =>
      start < Date.parse(booking.end_at) + buffer && end + buffer > Date.parse(booking.start_at),
    );
    const eligible = room.capacity >= Number(event.expected_attendance) && missing.length === 0 && !conflict;
    return {
      roomId: room.id,
      code: room.code,
      name: room.name,
      capacity: room.capacity,
      facilities,
      missingFacilities: missing,
      capacityFitScore: Math.round((Number(event.expected_attendance) / room.capacity) * 100),
      conflict: conflict ? { eventId: conflict.id, eventTitle: conflict.title, startAt: conflict.start_at, endAt: conflict.end_at } : null,
      eligible,
      reasons: [
        room.capacity >= Number(event.expected_attendance) ? 'Fits expected attendance' : 'Too small for expected attendance',
        missing.length ? `Missing: ${missing.join(', ')}` : 'Required facilities available',
        conflict ? `Conflicts with ${conflict.title}` : 'Available at this time',
      ],
    };
  });
  recommendations.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.capacityFitScore - a.capacityFitScore);
  res.json({
    configured: true,
    recommendations,
    conflicts: recommendations.filter((room) => room.conflict).map((room) => room.conflict),
  });
});

app.post('/api/events/:id/room', requireAuth, requireRole('organizer'), (req, res) => {
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
    SELECT e.title, e.start_at, e.end_at FROM events e
    WHERE e.room_id = ? AND e.id != ? AND e.status != 'cancelled'
  `).all(room.id, req.params.id) as Array<{ title: string; start_at: string; end_at: string }>;
  const buffer = room.buffer_minutes * 60_000;
  const collision = conflict.find((booking) =>
    start < Date.parse(booking.end_at) + buffer && end + buffer > Date.parse(booking.start_at),
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
  db.prepare(`
    UPDATE accounts SET faculty = ?, course = ?, interests = ?, clubs = ?, personalization_enabled = ?, in_app_preferences = ?
    WHERE id = ?
  `).run(
    input.faculty === undefined ? existing.faculty : input.faculty,
    input.course === undefined ? existing.course : input.course,
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

app.get('/api/organizer/analytics', requireAuth, requireRole('organizer'), (_req, res) => {
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
    const estimate = Math.round(event.registeredCount * turnoutRate);
    const margin = Math.max(3, Math.round(estimate * (history.samples >= 3 ? 0.15 : 0.3)));
    return { event, estimate, lowerBound: Math.max(0, estimate - margin), upperBound: Math.min(event.registrationCapacity, estimate + margin), historySamples: history.samples };
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
    predictionMethod: 'Confirmed registrations multiplied by seeded historical check-in rate.',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

function deliverScheduledInAppNotifications(): void {
  const now = new Date();
  const nowIso = now.toISOString();
  const reminderStart = new Date(now.getTime() + 23 * 60 * 60_000 + 59 * 60_000).toISOString();
  const reminderEnd = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const reminderRows = db.prepare(`
    SELECT e.id AS event_id, e.title, r.account_id
    FROM events e JOIN registrations r ON r.event_id = e.id
    WHERE e.status = 'published' AND r.status = 'registered'
      AND e.start_at > ? AND e.start_at <= ?
  `).all(reminderStart, reminderEnd) as Array<{ event_id: string; title: string; account_id: string }>;
  const closingRows = db.prepare(`
    SELECT e.id AS event_id, e.title, r.account_id
    FROM events e JOIN registrations r ON r.event_id = e.id
    WHERE e.status = 'published' AND r.status IN ('registered', 'waitlisted')
      AND e.registration_closes_at <= ?
  `).all(nowIso) as Array<{ event_id: string; title: string; account_id: string }>;
  const insertMarker = db.prepare(`
    INSERT OR IGNORE INTO notification_markers (event_id, account_id, kind, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const sendOnce = db.transaction((rows: typeof reminderRows, kind: string, message: (title: string) => string) => {
    for (const row of rows) {
      const marker = insertMarker.run(row.event_id, row.account_id, kind, nowIso);
      if (marker.changes === 1) createNotification(row.account_id, row.event_id, kind, message(row.title));
    }
  });
  sendOnce(reminderRows, 'event_reminder', (title) => `${title} starts within 24 hours.`);
  sendOnce(closingRows, 'registration_close', (title) => `Registration for ${title} has closed.`);
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
