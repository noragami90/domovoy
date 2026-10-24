// Local time, sunrise/sunset and time windows for rule cards — computed offline.
// Sun: the standard "sunrise equation" (accurate to about a minute; refraction −0.833°).
import { parseDuration } from '../duration.ts';

export interface Place { lat: number; lon: number }
export interface LocalDate { y: number; m: number; d: number }

const DAY = 86_400_000;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

// ── time zones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(ts)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

const offsetAt = (ts: number, tz: string) => {
  const p = parts(ts, tz);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ts / 1000) * 1000;
};

export function localDate(ts: number, tz: string): LocalDate {
  const p = parts(ts, tz);
  return { y: p.year!, m: p.month!, d: p.day! };
}

export function addDays(date: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const weekday = (date: LocalDate) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay(); // 0 = Sunday

// Wall-clock time in a zone → timestamp.
export function zoned(date: LocalDate, minutes: number, tz: string): number {
  const guess = Date.UTC(date.y, date.m - 1, date.d) + minutes * 60_000;
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

export function hhmm(ts: number, tz: string): string {
  const p = parts(ts, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// ── sun ─────────────────────────────────────────────────────────────────────

// Sunrise and sunset on a local date; null when the sun does not rise or set that day.
export function sunTimes(date: LocalDate, place: Place): { sunrise: number | null; sunset: number | null } {
  const noonUtc = Date.UTC(date.y, date.m - 1, date.d, 12) - (place.lon / 15) * 3_600_000;
  const n = Math.round(noonUtc / DAY + 2440587.5 - 2451545.0 + 0.0008);
  const jStar = n - place.lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(place.lat)) * sinDec) / (Math.cos(rad(place.lat)) * cosDec);
  if (cosH > 1 || cosH < -1) return { sunrise: null, sunset: null };
  const H = deg(Math.acos(cosH));
  const toTs = (j: number) => Math.round((j - 2440587.5) * DAY);
  return { sunrise: toTs(transit - H / 360), sunset: toTs(transit + H / 360) };
}

// ── time points and windows ─────────────────────────────────────────────────

// "07:30", "sunset", "sunrise+30m", "sunset-1h"
export const POINT_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|sunrise|sunset)(?:[+-](?:\d+(?:ms|s|m|h|d))+)?$/;

export function pointAt(point: string, date: LocalDate, tz: string, place: Place): number | null {
  const m = /^((?:\d\d:\d\d)|sunrise|sunset)([+-].+)?$/.exec(point);
  if (!m) throw new Error(`Неверное время: ${point}`);
  const shift = m[2] ? (m[2][0] === '-' ? -1 : 1) * parseDuration(m[2].slice(1)) : 0;
  if (m[1] === 'sunrise' || m[1] === 'sunset') {
    const sun = sunTimes(date, place)[m[1]];
    return sun === null ? null : sun + shift;
  }
  const [h, min] = m[1]!.split(':').map(Number);
  return zoned(date, h! * 60 + min!, tz) + shift;
}

export interface WindowSpec { between: [string, string]; days?: number[] }
export interface WindowState { inside: boolean; start: number; end: number; next: number }

// A window starts on each allowed local day at the first point and ends at the second one
// (on the next day if the second point comes earlier, e.g. 23:00–07:00).
export function windowAt(spec: WindowSpec, now: number, tz: string, place: Place): WindowState | null {
  const today = localDate(now, tz);
  const windows: [number, number][] = [];
  for (let k = -1; k <= 8; k++) {
    const day = addDays(today, k);
    if (spec.days && !spec.days.includes(weekday(day))) continue;
    const start = pointAt(spec.between[0], day, tz, place);
    let end = pointAt(spec.between[1], day, tz, place);
    if (start === null || end === null) continue;
    if (end <= start) end = pointAt(spec.between[1], addDays(day, 1), tz, place);
    if (end !== null) windows.push([start, end]);
  }
  const inside = windows.find(([s, e]) => now >= s && now < e);
  if (inside) return { inside: true, start: inside[0], end: inside[1], next: inside[1] };
  const upcoming = windows.filter(([s]) => s > now).sort((a, b) => a[0] - b[0])[0];
  return upcoming ? { inside: false, start: upcoming[0], end: upcoming[1], next: upcoming[0] } : null;
}

export const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
