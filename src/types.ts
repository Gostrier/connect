export type Role = 'student' | 'organizer';
export type DeliveryMode = 'in_person' | 'online' | 'hybrid';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  role: Role;
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

export interface CampusEvent {
  id: string;
  title: string;
  description: string;
  category: string;
  deliveryMode: DeliveryMode;
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

export interface NotificationItem {
  id: string;
  eventId: string | null;
  kind: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as T | { error?: string };
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload
      ? payload.error
      : 'The request could not be completed.';
    throw new Error(message || 'The request could not be completed.');
  }
  return payload as T;
}

export function formatDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...options,
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export const categories = [
  'Academic & Research',
  'Career & Networking',
  'Arts & Culture',
  'Clubs & Social',
  'Sports & Wellness',
  'Community Service',
];

export const facilities = ['Projector', 'Internet', 'Computer Lab', 'Conference Equipment'];
export const modeLabels: Record<DeliveryMode, string> = {
  in_person: 'In-person',
  online: 'Online',
  hybrid: 'Hybrid',
};
