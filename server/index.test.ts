import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

const { app } = await import('./index.js');
const { db } = await import('./db.js');

describe('CampusConnect API', () => {
  afterAll(() => db.close());

  it('serves a health check and reports that room allocation is unconfigured', async () => {
    const health = await request(app).get('/api/health');
    const rooms = await request(app).get('/api/rooms');

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(rooms.status).toBe(200);
    expect(rooms.body).toEqual({ configured: false, rooms: [] });
  });

  it('includes additional fictional events across more campus interests', async () => {
    const response = await request(app).get('/api/events').expect(200);
    const events = response.body.events as Array<{ id: string; category: string }>;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo-wellness-break', category: 'Sports & Wellness' }),
      expect.objectContaining({ id: 'demo-board-game-social', category: 'Clubs & Social' }),
      expect.objectContaining({ id: 'demo-portfolio-sprint', category: 'Career & Networking' }),
    ]));
  });

  it('shows sample events as in-person at the configured presentation venues', async () => {
    const response = await request(app).get('/api/events').expect(200);
    const events = response.body.events as Array<{
      id: string;
      deliveryMode: string;
      venueLabel: string | null;
      meetingUrl: string | null;
    }>;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo-ai-workshop', deliveryMode: 'in_person', venueLabel: 'Tuition Complex Room 20', meetingUrl: null }),
      expect.objectContaining({ id: 'demo-career-clinic', deliveryMode: 'in_person', venueLabel: 'Pavilion Grounds', meetingUrl: null }),
      expect.objectContaining({ id: 'demo-community-health', deliveryMode: 'in_person', venueLabel: 'Amphitheatre', meetingUrl: null }),
    ]));
    expect(events.filter((event) => event.id.startsWith('demo-'))).toHaveLength(7);
    expect(events.filter((event) => event.id.startsWith('demo-')).every((event) =>
      event.deliveryMode === 'in_person'
      && ['Tuition Complex Room 20', 'Pavilion Grounds', 'Amphitheatre'].includes(event.venueLabel ?? ''),
    )).toBe(true);
  });

  it('allows only synthetic test addresses to sign up', async () => {
    const rejected = await request(app).post('/api/auth/signup').send({
      displayName: 'Demo Student',
      email: 'student@example.com',
      password: 'A-long-demo-password',
    });
    const accepted = await request(app).post('/api/auth/signup').send({
      displayName: 'Demo Student',
      email: 'student-1@campusconnect.test',
      password: 'A-long-demo-password',
    });

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(201);
    expect(accepted.body.account.role).toBe('student');
    expect(accepted.headers['set-cookie'][0]).toContain('HttpOnly');
  });

  it('keeps multiple sign-up accounts separate and lets each sign in again', async () => {
    const firstAccount = request.agent(app);
    const secondAccount = request.agent(app);
    const firstCredentials = {
      email: 'first-account@campusconnect.test',
      password: 'First-account-password',
    };
    const secondCredentials = {
      email: 'second-account@campusconnect.test',
      password: 'Second-account-password',
    };

    await firstAccount.post('/api/auth/signup').send({
      displayName: 'First Account',
      ...firstCredentials,
    }).expect(201);
    await secondAccount.post('/api/auth/signup').send({
      displayName: 'Second Account',
      ...secondCredentials,
    }).expect(201);

    expect((await firstAccount.get('/api/auth/me').expect(200)).body.account.email).toBe(firstCredentials.email);
    expect((await secondAccount.get('/api/auth/me').expect(200)).body.account.email).toBe(secondCredentials.email);

    await firstAccount.post('/api/auth/logout').expect(204);
    await firstAccount.post('/api/auth/login').send({
      ...firstCredentials,
      password: secondCredentials.password,
    }).expect(401);
    await firstAccount.post('/api/auth/login').send(firstCredentials).expect(200);
    await secondAccount.post('/api/auth/logout').expect(204);
    await secondAccount.post('/api/auth/login').send(secondCredentials).expect(200);
  });

  it('automatically promotes the oldest waitlisted student after a cancellation', async () => {
    const organizer = request.agent(app);
    const firstStudent = request.agent(app);
    const secondStudent = request.agent(app);
    await organizer.post('/api/auth/login').send({ email: 'organizer@campusconnect.test', password: 'CampusDemo!2026' }).expect(200);
    await firstStudent.post('/api/auth/signup').send({
      displayName: 'First Student',
      email: 'first@campusconnect.test',
      password: 'A-long-demo-password',
    }).expect(201);
    await secondStudent.post('/api/auth/signup').send({
      displayName: 'Second Student',
      email: 'second@campusconnect.test',
      password: 'A-long-demo-password',
    }).expect(201);

    const start = new Date(Date.now() + 48 * 60 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    const closes = new Date(start.getTime() - 24 * 60 * 60_000);
    const created = await organizer.post('/api/events').send({
      title: 'A Small Test Workshop',
      description: 'A sufficiently detailed event description for the API test.',
      category: 'Academic & Research',
      deliveryMode: 'online',
      faculty: 'School of Computing',
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      registrationClosesAt: closes.toISOString(),
      expectedAttendance: 2,
      registrationCapacity: 1,
      requiredFacilities: [],
      meetingUrl: 'https://meet.example.test/test-workshop',
    }).expect(201);
    const eventId = created.body.event.id as string;
    await organizer.post(`/api/events/${eventId}/publish`).expect(200);
    await firstStudent.post(`/api/events/${eventId}/register`).expect(201, { status: 'registered' });
    await secondStudent.post(`/api/events/${eventId}/register`).expect(201, { status: 'waitlisted' });
    const waitingEvent = await secondStudent.get('/api/events').expect(200);
    expect(waitingEvent.body.events.find((event: { id: string }) => event.id === eventId).currentWaitlistPosition).toBe(1);

    await firstStudent.delete(`/api/events/${eventId}/register`).expect(200);
    const notifications = await secondStudent.get('/api/notifications').expect(200);
    const promoted = notifications.body.notifications.find((item: { message: string }) => item.message.includes('now registered'));

    expect(promoted).toBeDefined();
  });

  it('stores notification preferences and respects a muted registration category', async () => {
    const student = request.agent(app);
    await student.post('/api/auth/login').send({ email: 'student@campusconnect.test', password: 'CampusDemo!2026' }).expect(200);
    const updated = await student.patch('/api/me/profile').send({
      inAppPreferences: { registration: false },
    }).expect(200);

    expect(updated.body.account.inAppPreferences.registration).toBe(false);
    await student.post('/api/events/demo-culture-night/register').expect(201, { status: 'registered' });
    const notifications = await student.get('/api/notifications').expect(200);
    expect(notifications.body.notifications.some((item: { kind: string }) => item.kind === 'registration')).toBe(false);
  });

  it('keeps organizer analytics inaccessible to student accounts', async () => {
    const student = request.agent(app);
    await student.post('/api/auth/login').send({ email: 'student@campusconnect.test', password: 'CampusDemo!2026' }).expect(200);
    await student.get('/api/organizer/analytics').expect(403);
  });
});
