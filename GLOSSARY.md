# CampusConnect

CampusConnect helps students discover and register for campus events, and helps organizers publish events and coordinate venues.

## Accounts and events

**Student**:
A CampusConnect account using student features. In this presentation prototype, Student is a self-attested role and does not establish university enrollment.
_Avoid_: Verified student

**Organizer**:
A single-role account allowed to create and manage campus events after redeeming an authorized invitation.
_Avoid_: Event owner

**Event**:
A scheduled campus activity with a subject category, delivery mode, organizer, registration window, and attendance plan.
_Avoid_: Activity

**Event category**:
The subject of an event, such as Academic & Research or Arts & Culture.
_Avoid_: Event type

**Delivery mode**:
How an event is attended: In-person, Online, or Hybrid.
_Avoid_: Event category

**Expected attendance**:
The organizer's estimate of how many people will attend an event.
_Avoid_: Registration capacity

**Registration capacity**:
The maximum number of students who may hold confirmed registrations for an event.
_Avoid_: Expected attendance

**Waitlist**:
The first-in, first-out queue of students waiting for a confirmed registration when an event has reached its registration capacity.
_Avoid_: Standby list

## Venues and recommendations

**Room inventory**:
The administrator-supplied list of verified university venues, capacities, facilities, and applicable booking rules.
_Avoid_: Sample rooms

**Room allocation**:
An organizer-confirmed booking of an eligible room for an event.
_Avoid_: Room recommendation

**Room recommendation**:
A ranked suggestion for a room that is available, large enough for expected attendance, and equipped with every required facility.
_Avoid_: Automatic booking

**Recommendation score**:
A transparent event match score based equally on interests, faculty or course, club membership, and previous attendance.
_Avoid_: AI confidence

**Attendance estimate**:
An uncertain estimate based on confirmed registrations and seeded historical turnout.
_Avoid_: Attendance guarantee

**In-app notification**:
A message stored in CampusConnect for a student about a registration, reminder, or material event change.
_Avoid_: Push notification
