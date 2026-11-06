# CampusConnect

CampusConnect is a local presentation prototype for discovering university events and managing event registrations. It uses fictional demo accounts and sample events, and is not connected to a university service.

## Run locally

Requirements: Node.js 20.19 or newer and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite server proxies API requests to the local Express server on port 3001. SQLite data is stored in `data/campusconnect.sqlite`.

Demo sign-in:

| Role | Email | Password |
|---|---|---|
| Student | `student@campusconnect.test` | `CampusDemo!2026` |
| Organizer | `organizer@campusconnect.test` | `CampusDemo!2026` |

New accounts must provide a name, fictional email address ending in `.test`, faculty, course, password, and matching password confirmation. Students apply for Organizer access after signing in; an administrator reviews the application. To create an administrator, first create a normal account, then start the app with that account's email in `ADMIN_EMAILS`. For example: `ADMIN_EMAILS=admin@campusconnect.test npm run dev`. Multiple emails can be comma-separated. Existing accounts are enabled when the API starts; new accounts are enabled at signup. Administrators can manage users and rooms, review Organizer applications, and view reports.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run lint
```

## Data and integrations

- Events, registrations, and room bookings are stored locally in SQLite. Included sample events and account data are fictional.
- `data/rooms.json` is intentionally empty. Administrators can add rooms in the Administrator workspace and must mark factual details as verified before organizers can allocate them. Room inventory is imported from this file once; later changes made in the Administrator workspace persist in SQLite.
- In-app notifications are stored locally. Web Push and SMS are not configured, and no external messages are sent.
- Attendance check-in is available for registered students at in-person and hybrid events while the event is underway. The organizer opens and closes attendance; opening requires their device location and sets a 100 m check-in radius. Student location is checked for the request and not stored. Each check-in keeps the student's name, email, faculty, course, and check-in time for future reference, visible to that event's organizer. The room inventory has no verified coordinates yet, so the opening location is the temporary location reference.
- Dates are presented in the `Africa/Nairobi` time zone.
- Signup, Organizer applications, and local authentication are for this presentation prototype only. Do not use real student identities, passwords, production data, or deploy this as a university service.
