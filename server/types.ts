export type AccountRole = 'student' | 'organizer';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  role: AccountRole;
  organizerEnabled: boolean;
  adminEnabled: boolean;
  isActive: boolean;
  faculty: string | null;
  course: string | null;
  interests: string[];
  clubs: string[];
  personalizationEnabled: boolean;
  inAppPreferences: Record<string, boolean>;
}

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  category: string;
  deliveryMode: 'in_person' | 'online' | 'hybrid';
  faculty: string;
  clubName: string | null;
  startAt: string;
  endAt: string;
  registrationClosesAt: string;
  expectedAttendance: number;
  registrationCapacity: number;
  requiredFacilities: string[];
  roomId: string | null;
  roomName: string | null;
  meetingUrl: string | null;
  status: 'draft' | 'published' | 'cancelled';
  organizerName: string;
  isDemo: boolean;
  registeredCount: number;
  waitlistCount: number;
  seatsAvailable: number;
  currentRegistrationStatus?: 'registered' | 'waitlisted' | 'cancelled' | null;
  currentWaitlistPosition?: number | null;
}
