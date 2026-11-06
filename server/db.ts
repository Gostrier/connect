import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const inMemory = process.env.DB_PATH === ':memory:';
const databasePath = inMemory ? ':memory:' : path.resolve(process.env.DB_PATH ?? 'data/campusconnect.sqlite');
if (!inMemory) mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'organizer')),
    organizer_enabled INTEGER NOT NULL DEFAULT 0,
    admin_enabled INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    faculty TEXT,
    course TEXT,
    registration_no TEXT,
    interests TEXT NOT NULL DEFAULT '[]',
    clubs TEXT NOT NULL DEFAULT '[]',
    personalization_enabled INTEGER NOT NULL DEFAULT 1,
    in_app_preferences TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    facilities TEXT NOT NULL,
    buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
    verified INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('in_person', 'online', 'hybrid')),
    faculty TEXT NOT NULL,
    club_name TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    registration_closes_at TEXT NOT NULL,
    expected_attendance INTEGER NOT NULL CHECK (expected_attendance > 0),
    registration_capacity INTEGER NOT NULL CHECK (registration_capacity > 0),
    registration_capacity_custom INTEGER NOT NULL DEFAULT 0,
    required_facilities TEXT NOT NULL DEFAULT '[]',
    room_id TEXT REFERENCES rooms(id),
    venue_label TEXT,
    meeting_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'cancelled')),
    organizer_id TEXT NOT NULL REFERENCES accounts(id),
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    status TEXT NOT NULL CHECK (status IN ('registered', 'waitlisted', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (event_id, account_id)
  );

  CREATE INDEX IF NOT EXISTS registrations_event_status
    ON registrations(event_id, status, created_at);

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    event_id TEXT REFERENCES events(id),
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS notification_markers (
    event_id TEXT NOT NULL REFERENCES events(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, account_id, kind)
  );

  CREATE TABLE IF NOT EXISTS attendance_history (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    registration_count INTEGER NOT NULL,
    check_in_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attendance_sessions (
    event_id TEXT PRIMARY KEY REFERENCES events(id),
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    check_in_code TEXT
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    display_name_snapshot TEXT NOT NULL DEFAULT '',
    email_snapshot TEXT NOT NULL DEFAULT '',
    faculty_snapshot TEXT,
    course_snapshot TEXT,
    registration_no_snapshot TEXT,
    checked_in_at TEXT NOT NULL,
    UNIQUE (event_id, account_id)
  );

  CREATE TABLE IF NOT EXISTS organizer_applications (
    id TEXT PRIMARY KEY,
    applicant_id TEXT NOT NULL REFERENCES accounts(id),
    club_name TEXT NOT NULL,
    club_key TEXT NOT NULL,
    position TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewer_id TEXT REFERENCES accounts(id),
    review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS organizer_applications_club_status
    ON organizer_applications(club_key, status);
`);

const eventColumns = db.pragma('table_info(events)') as Array<{ name: string }>;
if (!eventColumns.some((column) => column.name === 'registration_capacity_custom')) {
  db.exec('ALTER TABLE events ADD COLUMN registration_capacity_custom INTEGER NOT NULL DEFAULT 0');
}
if (!eventColumns.some((column) => column.name === 'venue_label')) {
  db.exec('ALTER TABLE events ADD COLUMN venue_label TEXT');
}

const accountColumns = db.pragma('table_info(accounts)') as Array<{ name: string }>;
if (!accountColumns.some((column) => column.name === 'registration_no')) {
  db.exec('ALTER TABLE accounts ADD COLUMN registration_no TEXT');
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_registration_no_unique ON accounts(registration_no) WHERE registration_no IS NOT NULL AND registration_no != ''");
if (!accountColumns.some((column) => column.name === 'organizer_enabled')) {
  db.exec('ALTER TABLE accounts ADD COLUMN organizer_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!accountColumns.some((column) => column.name === 'admin_enabled')) {
  db.exec('ALTER TABLE accounts ADD COLUMN admin_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!accountColumns.some((column) => column.name === 'is_active')) {
  db.exec('ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}
if (!accountColumns.some((column) => column.name === 'in_app_preferences')) {
  db.exec("ALTER TABLE accounts ADD COLUMN in_app_preferences TEXT NOT NULL DEFAULT '{}'");
}

const attendanceRecordColumns = db.pragma('table_info(attendance_records)') as Array<{ name: string }>;
const attendanceSessionColumns = db.pragma('table_info(attendance_sessions)') as Array<{ name: string }>;
if (!attendanceSessionColumns.some((column) => column.name === 'check_in_code')) {
  db.exec('ALTER TABLE attendance_sessions ADD COLUMN check_in_code TEXT');
}
if (!attendanceRecordColumns.some((column) => column.name === 'display_name_snapshot')) {
  db.exec("ALTER TABLE attendance_records ADD COLUMN display_name_snapshot TEXT NOT NULL DEFAULT ''");
}
if (!attendanceRecordColumns.some((column) => column.name === 'email_snapshot')) {
  db.exec("ALTER TABLE attendance_records ADD COLUMN email_snapshot TEXT NOT NULL DEFAULT ''");
}
if (!attendanceRecordColumns.some((column) => column.name === 'faculty_snapshot')) {
  db.exec('ALTER TABLE attendance_records ADD COLUMN faculty_snapshot TEXT');
}
if (!attendanceRecordColumns.some((column) => column.name === 'course_snapshot')) {
  db.exec('ALTER TABLE attendance_records ADD COLUMN course_snapshot TEXT');
}
if (!attendanceRecordColumns.some((column) => column.name === 'registration_no_snapshot')) {
  db.exec('ALTER TABLE attendance_records ADD COLUMN registration_no_snapshot TEXT');
}
db.exec(`
  UPDATE attendance_records
  SET display_name_snapshot = COALESCE((SELECT display_name FROM accounts WHERE accounts.id = attendance_records.account_id), ''),
      email_snapshot = COALESCE((SELECT email FROM accounts WHERE accounts.id = attendance_records.account_id), ''),
      faculty_snapshot = (SELECT faculty FROM accounts WHERE accounts.id = attendance_records.account_id),
      course_snapshot = (SELECT course FROM accounts WHERE accounts.id = attendance_records.account_id),
      registration_no_snapshot = (SELECT registration_no FROM accounts WHERE accounts.id = attendance_records.account_id)
  WHERE display_name_snapshot = '' OR email_snapshot = ''
`);

const now = new Date();
const insertAccount = db.prepare(`
  INSERT OR IGNORE INTO accounts
    (id, email, display_name, password_hash, role, faculty, course, interests, clubs, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const demoPasswordHash = bcrypt.hashSync('CampusDemo!2026', 10);
const demoAccounts = [
  ['student@campusconnect.test', 'Nia Wanjiku', 'student', 'School of Computing', 'Information Technology', ['Academic & Research', 'Career & Networking'], ['Tech Society']],
  ['organizer@campusconnect.test', 'Amani Otieno', 'organizer', 'School of Computing', 'Information Technology', ['Academic & Research'], ['Tech Society']],
  ['admin@campusconnect.test', 'Campus Administrator', 'student', 'Campus Administration', 'Administration', [], []],
  ['samira@campusconnect.test', 'Samira Kibet', 'student', 'School of Business', 'Entrepreneurship', ['Career & Networking', 'Clubs & Social'], ['Business Club']],
  ['kiptoo@campusconnect.test', 'Kiptoo Maina', 'student', 'School of Health Sciences', 'Public Health', ['Community Service', 'Sports & Wellness'], ['Health Society']],
] as const;

for (const [email, name, role, faculty, course, interests, clubs] of demoAccounts) {
  insertAccount.run(
    randomUUID(),
    email,
    name,
    demoPasswordHash,
    role,
    faculty,
    course,
    JSON.stringify(interests),
    JSON.stringify(clubs),
    now.toISOString(),
  );
}

const environmentAdmins = (process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
const configuredAdmins = environmentAdmins.length ? environmentAdmins : ['admin@campusconnect.test'];
db.prepare('UPDATE accounts SET admin_enabled = 0').run();
const enableAdmin = db.prepare('UPDATE accounts SET admin_enabled = 1 WHERE email = ? COLLATE NOCASE');
for (const email of configuredAdmins) enableAdmin.run(email);

const organizer = db.prepare('SELECT id FROM accounts WHERE email = ?').get('organizer@campusconnect.test') as { id: string };
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events
    (id, title, description, category, delivery_mode, faculty, club_name, start_at, end_at,
     registration_closes_at, expected_attendance, registration_capacity, required_facilities,
     room_id, venue_label, meeting_url, status, organizer_id, is_demo, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'in_person', ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, NULL, 'published', ?, 1, ?, ?)
`);

const sampleEvents = [
  {
    id: 'demo-ai-workshop',
    title: 'AI for Everyone: Ideas to Impact',
    description: 'A practical, beginner-friendly workshop on using AI thoughtfully in research, study, and student projects.',
    category: 'Academic & Research',
    faculty: 'School of Computing',
    club: 'Tech Society',
    days: 3,
    startHour: 10,
    duration: 90,
    expected: 80,
    capacity: 100,
    venue: 'Tuition Complex Room 20',
  },
  {
    id: 'demo-career-clinic',
    title: 'CV Clinic and Career Q&A',
    description: 'Bring a draft CV, meet volunteer mentors, and leave with a short, actionable improvement plan.',
    category: 'Career & Networking',
    faculty: 'School of Business',
    club: 'Career Circle',
    days: 4,
    startHour: 14,
    duration: 60,
    expected: 45,
    capacity: 60,
    venue: 'Pavilion Grounds',
  },
  {
    id: 'demo-community-health',
    title: 'Community Health Research Exchange',
    description: 'Students share community health project methods and discuss practical ways to collaborate across disciplines.',
    category: 'Community Service',
    faculty: 'School of Health Sciences',
    club: 'Health Society',
    days: 6,
    startHour: 11,
    duration: 75,
    expected: 55,
    capacity: 70,
    venue: 'Amphitheatre',
  },
  {
    id: 'demo-culture-night',
    title: 'Campus Culture Night',
    description: 'An evening of student performances, creative showcases, and stories from across the campus community.',
    category: 'Arts & Culture',
    faculty: 'Campus-wide',
    club: 'Arts Collective',
    days: 8,
    startHour: 18,
    duration: 120,
    expected: 120,
    capacity: 150,
    venue: 'Tuition Complex Room 20',
  },
  {
    id: 'demo-wellness-break',
    title: 'Evening Reset: Guided Stretch Session',
    description: 'Take a screen break and join a gentle, beginner-friendly stretch session led by the Wellness Circle.',
    category: 'Sports & Wellness',
    faculty: 'Campus-wide',
    club: 'Wellness Circle',
    days: 5,
    startHour: 17,
    duration: 45,
    expected: 40,
    capacity: 60,
    venue: 'Pavilion Grounds',
  },
  {
    id: 'demo-board-game-social',
    title: 'Board Games & New Friends',
    description: 'Meet fellow students, learn a quick game, and spend a relaxed evening making new campus connections.',
    category: 'Clubs & Social',
    faculty: 'Campus-wide',
    club: 'Student Community',
    days: 7,
    startHour: 16,
    duration: 90,
    expected: 90,
    capacity: 120,
    venue: 'Amphitheatre',
  },
  {
    id: 'demo-portfolio-sprint',
    title: 'Portfolio Sprint: Show Your Work',
    description: 'Get practical feedback from peers and mentors as you shape a small project into a portfolio-ready story.',
    category: 'Career & Networking',
    faculty: 'School of Design',
    club: 'Creative Careers Club',
    days: 9,
    startHour: 13,
    duration: 90,
    expected: 55,
    capacity: 80,
    venue: 'Tuition Complex Room 20',
  },
];

for (const event of sampleEvents) {
  const start = new Date();
  start.setDate(start.getDate() + event.days);
  start.setHours(event.startHour, 0, 0, 0);
  const end = new Date(start.getTime() + event.duration * 60_000);
  const closes = new Date(start.getTime() - 24 * 60 * 60_000);
  insertEvent.run(
    event.id,
    event.title,
    event.description,
    event.category,
    event.faculty,
    event.club,
    start.toISOString(),
    end.toISOString(),
    closes.toISOString(),
    event.expected,
    event.capacity,
    event.venue,
    organizer.id,
    now.toISOString(),
    now.toISOString(),
  );
  db.prepare(`
    UPDATE events SET delivery_mode = 'in_person', venue_label = ?, meeting_url = NULL
    WHERE id = ? AND is_demo = 1
  `).run(event.venue, event.id);
}

const accountIdForEmail = (email: string): string => {
  const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as { id: string };
  return account.id;
};
const insertRegistration = db.prepare(`
  INSERT OR IGNORE INTO registrations (id, event_id, account_id, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
[
  ['demo-ai-workshop', 'student@campusconnect.test', 'registered'],
  ['demo-career-clinic', 'samira@campusconnect.test', 'registered'],
  ['demo-community-health', 'kiptoo@campusconnect.test', 'registered'],
].forEach(([eventId, email, status]) => {
  insertRegistration.run(randomUUID(), eventId, accountIdForEmail(email), status, now.toISOString(), now.toISOString());
});

const insertHistory = db.prepare(`
  INSERT OR IGNORE INTO attendance_history (id, event_id, registration_count, check_in_count)
  VALUES (?, ?, ?, ?)
`);
[
  ['history-1', 'demo-ai-workshop', 72, 61],
  ['history-2', 'demo-career-clinic', 48, 39],
  ['history-3', 'demo-community-health', 53, 47],
].forEach((row) => insertHistory.run(...row));

export function loadVerifiedRoomInventory(): void {
  const importState = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('room_inventory_imported') as { value: string } | undefined;
  if (importState?.value === '3') return;
  const inventoryPath = path.resolve('data/rooms.json');
  const contents = readFileSync(inventoryPath, 'utf8');
  const inventorySchema = z.array(z.object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    capacity: z.number().int().positive(),
    facilities: z.array(z.string().trim().min(1).max(80)),
    bufferMinutes: z.number().int().nonnegative().optional(),
  }));
  const parsedInventory = inventorySchema.safeParse(JSON.parse(contents));
  if (!parsedInventory.success) {
    throw new Error(`Room inventory is invalid: ${parsedInventory.error.issues[0]?.message ?? 'check data/rooms.json'}`);
  }
  const inventory = parsedInventory.data;
  const upsert = db.prepare(`
    INSERT INTO rooms (id, code, name, capacity, facilities, buffer_minutes, verified)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(code) DO UPDATE SET
      facilities = excluded.facilities,
      verified = 1
  `);
  const transaction = db.transaction((rooms: typeof inventory) => {
    for (const room of rooms) {
      upsert.run(
        randomUUID(),
        room.code,
        room.name,
        room.capacity,
        JSON.stringify(room.facilities),
        room.bufferMinutes ?? 0,
      );
    }
  });
  transaction(inventory);
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('room_inventory_imported', '3');
}
