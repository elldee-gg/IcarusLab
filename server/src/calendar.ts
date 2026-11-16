import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http-error.js';

type Person = { username: string; displayName: string };
type Guest = Person & { status: 'pending' | 'yes' | 'no' | 'maybe' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['pending', 'yes', 'no', 'maybe']);

export function removeUserCalendar(db: DatabaseSync, userId: string) {
  const events = db.prepare('SELECT id FROM events WHERE owner_id = ?').all(userId) as { id: string }[];
  for (const event of events) db.prepare('DELETE FROM event_guests WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM event_guests WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM events WHERE owner_id = ?').run(userId);
  const tasks = db.prepare('SELECT id FROM tasks WHERE owner_id = ?').all(userId) as { id: string }[];
  for (const task of tasks) db.prepare('DELETE FROM task_shares WHERE task_id = ?').run(task.id);
  db.prepare('DELETE FROM task_shares WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM tasks WHERE owner_id = ?').run(userId);
}

export function listCalendar(db: DatabaseSync, userId: string, from: number, to: number, startDay: string, endDay: string) {
  const events = db
    .prepare(
      `SELECT e.id, e.owner_id, e.title, e.details, e.all_day, e.starts_at, e.ends_at, u.username, u.display_name
       FROM events e
       JOIN users u ON u.id = e.owner_id
       WHERE e.starts_at < ? AND e.ends_at > ?
         AND (e.owner_id = ? OR EXISTS (SELECT 1 FROM event_guests g WHERE g.event_id = e.id AND g.user_id = ?))
       ORDER BY e.starts_at, e.title`,
    )
    .all(to, from, userId, userId) as EventRow[];
  const tasks = db
    .prepare(
      `SELECT t.id, t.owner_id, t.title, t.due_day, t.done, u.username, u.display_name
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
       WHERE t.due_day >= ? AND t.due_day <= ?
         AND (t.owner_id = ? OR EXISTS (SELECT 1 FROM task_shares s WHERE s.task_id = t.id AND s.user_id = ?))
       ORDER BY t.due_day, t.done, t.title`,
    )
    .all(startDay, endDay, userId, userId) as TaskRow[];
  const eventIds = events.map((event) => event.id);
  const taskIds = tasks.map((task) => task.id);
  const guests = peopleFor(db, 'event_guests', 'event_id', eventIds, true);
  const shares = peopleFor(db, 'task_shares', 'task_id', taskIds, false);
  return {
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      details: event.details,
      allDay: event.all_day === 1,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      mine: event.owner_id === userId,
      owner: { username: event.username, displayName: event.display_name },
      guests: (guests.get(event.id) ?? []) as Guest[],
      myStatus: event.owner_id === userId ? null : ((guests.get(event.id) ?? []).find((guest) => guest.userId === userId)?.status ?? 'pending'),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      dueDay: task.due_day,
      done: task.done === 1,
      mine: task.owner_id === userId,
      owner: { username: task.username, displayName: task.display_name },
      shares: (shares.get(task.id) ?? []).map(({ username, displayName }) => ({ username, displayName })),
    })),
  };
}

export function createEvent(db: DatabaseSync, ownerId: string, body: Record<string, unknown>) {
  const title = cleanTitle(body.title);
  const details = cleanDetails(body.details);
  const when = timeRange(body.allDay === true, body.startsAt, body.endsAt);
  const guests = resolvePeople(db, ownerId, body.guests);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO events (id, owner_id, title, details, all_day, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, title, details, when.allDay ? 1 : 0, when.startsAt, when.endsAt, now, now);
  for (const guest of guests) db.prepare(`INSERT INTO event_guests (event_id, user_id, status) VALUES (?, ?, 'pending')`).run(id, guest);
  return id;
}

export function updateEvent(db: DatabaseSync, ownerId: string, id: string, body: Record<string, unknown>) {
  const event = ownEvent(db, ownerId, id);
  const title = body.title === undefined ? event.title : cleanTitle(body.title);
  const details = body.details === undefined ? event.details : cleanDetails(body.details);
  const when = timeRange(body.allDay === undefined ? event.all_day === 1 : body.allDay === true, body.startsAt ?? event.starts_at, body.endsAt ?? event.ends_at);
  db.prepare(`UPDATE events SET title = ?, details = ?, all_day = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`).run(
    title,
    details,
    when.allDay ? 1 : 0,
    when.startsAt,
    when.endsAt,
    Date.now(),
    id,
  );
  if (body.guests !== undefined) replaceGuests(db, id, resolvePeople(db, ownerId, body.guests));
}

export function deleteEvent(db: DatabaseSync, ownerId: string, id: string) {
  ownEvent(db, ownerId, id);
  db.prepare('DELETE FROM event_guests WHERE event_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

export function respondToEvent(db: DatabaseSync, userId: string, id: string, status: unknown) {
  if (typeof status !== 'string' || !STATUSES.has(status) || status === 'pending') throw new HttpError(400, 'Choose yes, no, or maybe');
  const guest = db.prepare('SELECT user_id FROM event_guests WHERE event_id = ? AND user_id = ?').get(id, userId);
  if (!guest) throw new HttpError(404, 'Event not found');
  db.prepare('UPDATE event_guests SET status = ? WHERE event_id = ? AND user_id = ?').run(status, id, userId);
}

export function createTask(db: DatabaseSync, ownerId: string, body: Record<string, unknown>) {
  const title = cleanTitle(body.title);
  const dueDay = cleanDay(body.dueDay);
  const shares = resolvePeople(db, ownerId, body.shares);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO tasks (id, owner_id, title, due_day, done, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(id, ownerId, title, dueDay, now, now);
  for (const share of shares) db.prepare('INSERT INTO task_shares (task_id, user_id) VALUES (?, ?)').run(id, share);
  return id;
}

export function updateTask(db: DatabaseSync, userId: string, id: string, body: Record<string, unknown>) {
  const task = visibleTask(db, userId, id);
  const mine = task.owner_id === userId;
  if (!mine && (body.title !== undefined || body.dueDay !== undefined || body.shares !== undefined)) {
    throw new HttpError(403, 'Only the owner can change this task');
  }
  const title = body.title === undefined ? task.title : cleanTitle(body.title);
  const dueDay = body.dueDay === undefined ? task.due_day : cleanDay(body.dueDay);
  const done = body.done === undefined ? task.done : body.done === true ? 1 : 0;
  db.prepare('UPDATE tasks SET title = ?, due_day = ?, done = ?, updated_at = ? WHERE id = ?').run(title, dueDay, done, Date.now(), id);
  if (mine && body.shares !== undefined) replaceShares(db, id, resolvePeople(db, userId, body.shares));
}

export function deleteTask(db: DatabaseSync, ownerId: string, id: string) {
  const task = visibleTask(db, ownerId, id);
  if (task.owner_id !== ownerId) throw new HttpError(403, 'Only the owner can delete this task');
  db.prepare('DELETE FROM task_shares WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

type EventRow = {
  id: string;
  owner_id: string;
  title: string;
  details: string;
  all_day: number;
  starts_at: number;
  ends_at: number;
  username: string;
  display_name: string;
};

type TaskRow = {
  id: string;
  owner_id: string;
  title: string;
  due_day: string;
  done: number;
  username: string;
  display_name: string;
};

function ownEvent(db: DatabaseSync, ownerId: string, id: string) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  if (!event || event.owner_id !== ownerId) throw new HttpError(404, 'Event not found');
  return event;
}

function visibleTask(db: DatabaseSync, userId: string, id: string) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.owner_id === userId) return task;
  const share = db.prepare('SELECT user_id FROM task_shares WHERE task_id = ? AND user_id = ?').get(id, userId);
  if (!share) throw new HttpError(404, 'Task not found');
  return task;
}

function replaceGuests(db: DatabaseSync, eventId: string, guestIds: string[]) {
  const current = db.prepare('SELECT user_id, status FROM event_guests WHERE event_id = ?').all(eventId) as { user_id: string; status: string }[];
  const kept = new Map(current.map((row) => [row.user_id, row.status]));
  db.prepare('DELETE FROM event_guests WHERE event_id = ?').run(eventId);
  for (const guestId of guestIds) {
    db.prepare('INSERT INTO event_guests (event_id, user_id, status) VALUES (?, ?, ?)').run(eventId, guestId, kept.get(guestId) ?? 'pending');
  }
}

function replaceShares(db: DatabaseSync, taskId: string, userIds: string[]) {
  db.prepare('DELETE FROM task_shares WHERE task_id = ?').run(taskId);
  for (const userId of userIds) db.prepare('INSERT INTO task_shares (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
}

function peopleFor(db: DatabaseSync, table: 'event_guests' | 'task_shares', column: 'event_id' | 'task_id', ids: string[], withStatus: boolean) {
  const grouped = new Map<string, (Person & { userId: string; status?: Guest['status'] })[]>();
  if (ids.length === 0) return grouped;
  const marks = ids.map(() => '?').join(', ');
  const statusColumn = withStatus ? ', p.status' : '';
  const rows = db
    .prepare(
      `SELECT p.${column} AS parent_id, u.id AS user_id, u.username, u.display_name${statusColumn}
       FROM ${table} p JOIN users u ON u.id = p.user_id
       WHERE p.${column} IN (${marks})
       ORDER BY u.username`,
    )
    .all(...ids) as { parent_id: string; user_id: string; username: string; display_name: string; status?: Guest['status'] }[];
  for (const row of rows) {
    const list = grouped.get(row.parent_id) ?? [];
    list.push({ userId: row.user_id, username: row.username, displayName: row.display_name, status: row.status });
    grouped.set(row.parent_id, list);
  }
  return grouped;
}

function resolvePeople(db: DatabaseSync, ownerId: string, value: unknown) {
  if (value === undefined || value === null) return [];
  const names = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!names) throw new HttpError(400, 'Invite people by username');
  const ids: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') throw new HttpError(400, 'Invite people by username');
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    const user = db.prepare('SELECT id, disabled FROM users WHERE username = ?').get(trimmed) as { id: string; disabled: number } | undefined;
    if (!user || user.disabled) throw new HttpError(400, `No account named ${trimmed}`);
    if (user.id === ownerId || ids.includes(user.id)) continue;
    ids.push(user.id);
  }
  if (ids.length > 50) throw new HttpError(400, 'Share with up to 50 people');
  return ids;
}

function cleanTitle(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a title');
  const title = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!title || title.length > 200) throw new HttpError(400, 'Enter a title up to 200 characters');
  return title;
}

function cleanDetails(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Details must be text');
  const details = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (details.length > 4000) throw new HttpError(400, 'Details can be up to 4000 characters');
  return details;
}

function cleanDay(value: unknown) {
  if (typeof value !== 'string' || !DAY.test(value)) throw new HttpError(400, 'Choose a day');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year!, month! - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day) throw new HttpError(400, 'Choose a day');
  return value;
}

function timeRange(allDay: boolean, startsAt: unknown, endsAt: unknown) {
  if (typeof startsAt !== 'number' || typeof endsAt !== 'number' || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    throw new HttpError(400, 'Choose a start and end');
  }
  const start = Math.trunc(startsAt);
  const end = Math.trunc(endsAt);
  if (end <= start) throw new HttpError(400, 'The end must be after the start');
  if (end - start > 366 * 24 * 60 * 60 * 1000) throw new HttpError(400, 'An item can cover up to a year');
  return { allDay, startsAt: start, endsAt: end };
}
