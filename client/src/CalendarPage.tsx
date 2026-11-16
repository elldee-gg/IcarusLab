import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Heading, Panel } from './shell';

type Person = { username: string; displayName: string };
type Guest = Person & { status: 'pending' | 'yes' | 'no' | 'maybe' };
type EventItem = {
  id: string;
  title: string;
  details: string;
  allDay: boolean;
  startsAt: number;
  endsAt: number;
  mine: boolean;
  owner: Person;
  guests: Guest[];
  myStatus: Guest['status'] | null;
};
type TaskItem = {
  id: string;
  title: string;
  dueDay: string;
  done: boolean;
  mine: boolean;
  owner: Person;
  shares: Person[];
};
type Draft = {
  id?: string;
  kind: 'event' | 'task';
  title: string;
  details: string;
  allDay: boolean;
  day: string;
  endDay: string;
  startTime: string;
  endTime: string;
  people: string;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(dayKey(new Date()));
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const days = useMemo(() => (mode === 'month' ? monthDays(cursor) : weekDays(selected)), [mode, cursor, selected]);
  const rangeKey = `${dayKey(days[0]!)}:${dayKey(days[days.length - 1]!)}`;

  async function load(range = days) {
    const start = startOfDay(range[0]!);
    const end = startOfDay(range[range.length - 1]!);
    end.setDate(end.getDate() + 1);
    try {
      const data = await api<{ events: EventItem[]; tasks: TaskItem[] }>(
        `/api/calendar?from=${start.getTime()}&to=${end.getTime()}&startDay=${dayKey(range[0]!)}&endDay=${dayKey(range[range.length - 1]!)}`,
      );
      setEvents(data.events);
      setTasks(data.tasks);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the calendar');
    }
  }

  useEffect(() => {
    void load(days);
  }, [rangeKey]);

  const selectedDate = parseDay(selected);
  const dayEvents = events.filter((event) => overlapsDay(event, selectedDate)).sort((a, b) => a.startsAt - b.startsAt);
  const dayTasks = tasks.filter((task) => task.dueDay === selected);

  function openNew(kind: Draft['kind']) {
    setFormError('');
    setDraft({ kind, title: '', details: '', allDay: false, day: selected, endDay: selected, startTime: '09:00', endTime: '10:00', people: '' });
  }

  function openEvent(event: EventItem) {
    if (!event.mine) return;
    const start = new Date(event.startsAt);
    const end = new Date(event.allDay ? event.endsAt - 1 : event.endsAt);
    setFormError('');
    setDraft({
      id: event.id,
      kind: 'event',
      title: event.title,
      details: event.details,
      allDay: event.allDay,
      day: dayKey(start),
      endDay: dayKey(end),
      startTime: timeKey(start),
      endTime: event.allDay ? '10:00' : timeKey(new Date(event.endsAt)),
      people: event.guests.map((guest) => guest.username).join(', '),
    });
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setFormError('');
    try {
      if (draft.kind === 'task') {
        const body = { title: draft.title, dueDay: draft.day, shares: draft.people };
        if (draft.id) await api(`/api/calendar/tasks/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/calendar/tasks', { method: 'POST', body: JSON.stringify(body) });
      } else {
        const startsAt = draft.allDay ? startOfDay(parseDay(draft.day)).getTime() : new Date(`${draft.day}T${draft.startTime}`).getTime();
        const endMarker = startOfDay(parseDay(draft.endDay));
        endMarker.setDate(endMarker.getDate() + 1);
        const endsAt = draft.allDay ? endMarker.getTime() : new Date(`${draft.endDay}T${draft.endTime}`).getTime();
        const body = { title: draft.title, details: draft.details, allDay: draft.allDay, startsAt, endsAt, guests: draft.people };
        if (draft.id) await api(`/api/calendar/events/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/calendar/events', { method: 'POST', body: JSON.stringify(body) });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  async function removeDraft() {
    if (!draft?.id) return;
    const path = draft.kind === 'task' ? `/api/calendar/tasks/${draft.id}` : `/api/calendar/events/${draft.id}`;
    if (!window.confirm(`Delete this ${draft.kind}?`)) return;
    await api(path, { method: 'DELETE' });
    setDraft(null);
    await load();
  }

  return (
    <>
        <main className="calendar-layout">
          <Panel className="cal-board">
            <div className="toolbar">
              <div className="crumbs">
                <button type="button" onClick={() => shiftCursor(-1)}>Previous</button>
                <button type="button" onClick={() => { const today = new Date(); setCursor(today); setSelected(dayKey(today)); }}>Today</button>
                <button type="button" onClick={() => shiftCursor(1)}>Next</button>
                <Heading>{mode === 'month' ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : `Week of ${days[0]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</Heading>
              </div>
              <div className="choice-row">
                <button type="button" className={mode === 'month' ? 'active' : ''} onClick={() => setMode('month')}>Month</button>
                <button type="button" className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>Week</button>
              </div>
            </div>
            {error && <p className="error">{error}</p>}
            {mode === 'month' ? (
              <div className="cal-grid">
                {WEEKDAYS.map((name) => <div className="cal-head" key={name}>{name}</div>)}
                {days.map((day) => {
                  const key = dayKey(day);
                  const items = events.filter((item) => overlapsDay(item, day));
                  const due = tasks.filter((item) => item.dueDay === key);
                  const shown = [...items.slice(0, 3).map((item) => ({ id: item.id, label: item.allDay ? item.title : `${clock(item.startsAt)} ${item.title}`, declined: item.myStatus === 'no', event: item })), ...due.slice(0, Math.max(0, 3 - Math.min(items.length, 3))).map((item) => ({ id: item.id, label: item.title, declined: item.done, event: null as EventItem | null }))];
                  const extra = items.length + due.length - shown.length;
                  return (
                    <div key={key} className={`cal-cell${day.getMonth() === cursor.getMonth() ? '' : ' outside'}${key === selected ? ' selected' : ''}`}>
                      <button type="button" className={`day-num${key === dayKey(new Date()) ? ' today' : ''}`} onClick={() => setSelected(key)}>{day.getDate()}</button>
                      {shown.map((item) => (
                        <button key={item.id} type="button" className={`cal-chip${item.declined ? ' declined' : ''}${item.event && !item.event.mine ? ' guest' : ''}`} onClick={() => { setSelected(key); if (item.event) openEvent(item.event); }}>
                          {item.label}
                        </button>
                      ))}
                      {extra > 0 && <span className="hint">+{extra} more</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="cal-week">
                {days.map((day) => {
                  const key = dayKey(day);
                  const items = events.filter((item) => overlapsDay(item, day)).sort((a, b) => a.startsAt - b.startsAt);
                  const due = tasks.filter((item) => item.dueDay === key);
                  return (
                    <div key={key} className={`cal-cell${key === selected ? ' selected' : ''}`}>
                      <button type="button" className={`day-num${key === dayKey(new Date()) ? ' today' : ''}`} onClick={() => setSelected(key)}>{WEEKDAYS[day.getDay()]} {day.getDate()}</button>
                      {items.map((item) => (
                        <button key={item.id} type="button" className={`cal-chip${item.myStatus === 'no' ? ' declined' : ''}${item.mine ? '' : ' guest'}`} onClick={() => { setSelected(key); openEvent(item); }}>
                          {item.allDay ? item.title : `${clock(item.startsAt)} ${item.title}`}
                        </button>
                      ))}
                      {due.map((item) => <span key={item.id} className={`cal-task${item.done ? ' declined' : ''}`}>{item.title}</span>)}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
          <Panel className="day-panel" title={selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => openNew('event')}>Add event</button>
              <button type="button" onClick={() => openNew('task')}>Add task</button>
            </div>
            {dayEvents.length === 0 && dayTasks.length === 0 && <p className="empty">Nothing on this day.</p>}
            {dayEvents.map((item) => (
              <article key={item.id} className="agenda-item">
                <button type="button" className="text" onClick={() => openEvent(item)} disabled={!item.mine}>
                  <strong>{item.title}</strong>
                </button>
                <p className="hint">{item.allDay ? 'All day' : `${clock(item.startsAt)} – ${clock(item.endsAt)}`} · {item.mine ? 'You' : item.owner.displayName || item.owner.username}</p>
                {item.details && <p>{item.details}</p>}
                {item.guests.length > 0 && <p className="hint">{item.guests.map((guest) => `${guest.username} (${guest.status})`).join(', ')}</p>}
                {!item.mine && (
                  <div className="choice-row">
                    {(['yes', 'no', 'maybe'] as const).map((choice) => (
                      <button key={choice} type="button" className={item.myStatus === choice ? 'active' : ''} onClick={() => void api(`/api/calendar/events/${item.id}/rsvp`, { method: 'POST', body: JSON.stringify({ status: choice }) }).then(() => load())}>{choice}</button>
                    ))}
                  </div>
                )}
              </article>
            ))}
            {dayTasks.map((item) => (
              <article key={item.id} className="agenda-item">
                <label className="check">
                  <input type="checkbox" checked={item.done} onChange={() => void api(`/api/calendar/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ done: !item.done }) }).then(() => load())} />
                  <span className={item.done ? 'declined' : ''}>{item.title}</span>
                </label>
                <p className="hint">{item.mine ? 'Your task' : `${item.owner.displayName || item.owner.username}'s task`}{item.shares.length > 0 ? ` · shared with ${item.shares.map((person) => person.username).join(', ')}` : ''}</p>
                {item.mine && <button type="button" onClick={() => { setFormError(''); setDraft({ id: item.id, kind: 'task', title: item.title, details: '', allDay: false, day: item.dueDay, endDay: item.dueDay, startTime: '09:00', endTime: '10:00', people: item.shares.map((person) => person.username).join(', ') }); }}>Edit</button>}
              </article>
            ))}
          </Panel>
        </main>
      {draft && (
        <div className="modal-back" onMouseDown={() => setDraft(null)}>
          <form className="glass modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveDraft(event)}>
            <Heading>{draft.id ? 'Edit' : 'New'} {draft.kind}</Heading>
            <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required /></label>
            {draft.kind === 'event' && (
              <>
                <label className="check"><input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })} /> All day</label>
                <div className="field-grid">
                  <label>Starts<input type="date" value={draft.day} onChange={(event) => setDraft({ ...draft, day: event.target.value, endDay: event.target.value > draft.endDay ? event.target.value : draft.endDay })} required /></label>
                  {!draft.allDay && <label>Time<input type="time" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} required /></label>}
                  <label>Ends<input type="date" value={draft.endDay} onChange={(event) => setDraft({ ...draft, endDay: event.target.value })} required /></label>
                  {!draft.allDay && <label>Time<input type="time" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} required /></label>}
                </div>
                <label>Details<textarea value={draft.details} onChange={(event) => setDraft({ ...draft, details: event.target.value })} rows={3} /></label>
                <label>Invite<input value={draft.people} onChange={(event) => setDraft({ ...draft, people: event.target.value })} placeholder="usernames, separated by commas" /></label>
              </>
            )}
            {draft.kind === 'task' && (
              <>
                <label>Day<input type="date" value={draft.day} onChange={(event) => setDraft({ ...draft, day: event.target.value })} required /></label>
                <label>Share with<input value={draft.people} onChange={(event) => setDraft({ ...draft, people: event.target.value })} placeholder="usernames, separated by commas" /></label>
              </>
            )}
            {formError && <p className="error">{formError}</p>}
            <div className="modal-actions">
              <button className="primary" type="submit">Save</button>
              {draft.id && <button className="danger" type="button" onClick={() => void removeDraft()}>Delete</button>}
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </>
  );

  function shiftCursor(direction: number) {
    if (mode === 'month') {
      const next = new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
      setCursor(next);
      return;
    }
    const next = parseDay(selected);
    next.setDate(next.getDate() + direction * 7);
    setSelected(dayKey(next));
    setCursor(next);
  }
}

function monthDays(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function weekDays(key: string) {
  const start = parseDay(key);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function overlapsDay(event: EventItem, day: Date) {
  const start = startOfDay(day).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return event.startsAt < end && event.endsAt > start;
}

function startOfDay(day: Date) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function dayKey(day: Date) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function parseDay(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year!, month! - 1, day);
}

function timeKey(day: Date) {
  return `${String(day.getHours()).padStart(2, '0')}:${String(day.getMinutes()).padStart(2, '0')}`;
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
