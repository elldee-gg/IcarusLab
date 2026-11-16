import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Heading, Panel } from './shell';

export type ColorMode = 'system' | 'light' | 'dark';
export type Aesthetic = 'win98' | 'winxp' | 'winvista' | 'modern' | 'html';
export type Appearance = { colorMode: ColorMode; aesthetic: Aesthetic };

const MODES = new Set<ColorMode>(['system', 'light', 'dark']);
const KNOWN_LOOKS = new Set<Aesthetic>(['win98', 'winxp', 'winvista', 'modern', 'html']);

const AppearanceContext = createContext<{
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
} | null>(null);

export function readCachedAppearance(): Appearance {
  const colorMode = localStorage.getItem('icarus-theme');
  const aesthetic = localStorage.getItem('icarus-aesthetic');
  return {
    colorMode: MODES.has(colorMode as ColorMode) ? (colorMode as ColorMode) : 'system',
    aesthetic: KNOWN_LOOKS.has(aesthetic as Aesthetic) ? (aesthetic as Aesthetic) : 'winvista',
  };
}

export function applyAppearance(appearance: Appearance) {
  const dark = appearance.colorMode === 'dark' || (appearance.colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = appearance.colorMode;
  document.documentElement.dataset.aesthetic = appearance.aesthetic;
  localStorage.setItem('icarus-theme', appearance.colorMode);
  localStorage.setItem('icarus-aesthetic', appearance.aesthetic);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [appearance, setAppearance] = useState<Appearance>(readCachedAppearance);

  useEffect(() => {
    applyAppearance(appearance);
    if (appearance.colorMode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyAppearance({ ...appearance, colorMode: 'system' });
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);

  useEffect(() => {
    if (status !== 'in') return;
    let stopped = false;
    void api<Appearance>('/api/appearance')
      .then((next) => {
        if (!stopped && MODES.has(next.colorMode) && KNOWN_LOOKS.has(next.aesthetic)) setAppearance(next);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [status]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'icarus-theme' || event.key === 'icarus-aesthetic') setAppearance(readCachedAppearance());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return <AppearanceContext.Provider value={{ appearance, setAppearance }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('Appearance is unavailable');
  return value;
}

const LOOKS: { id: Aesthetic; label: string }[] = [
  { id: 'win98', label: 'Windows 98' },
  { id: 'winxp', label: 'Windows XP' },
  { id: 'winvista', label: 'Windows Vista' },
  { id: 'modern', label: 'Modern' },
  { id: 'html', label: 'HTML' },
];

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'system', label: 'Match this computer' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export function AppearanceFields() {
  const { appearance, setAppearance } = useAppearance();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function save(partial: Partial<Appearance>) {
    setSaved('');
    setError('');
    try {
      const next = await api<Appearance>('/api/appearance', { method: 'PUT', body: JSON.stringify(partial) });
      setAppearance(next);
      setSaved('Saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the appearance');
    }
  }

  return (
    <>
      <Heading>Color</Heading>
      <div className="choice-row" role="group" aria-label="Color">
        {COLOR_MODES.map((mode) => (
          <button key={mode.id} type="button" className={appearance.colorMode === mode.id ? 'active' : ''} aria-pressed={appearance.colorMode === mode.id} onClick={() => void save({ colorMode: mode.id })}>
            {mode.label}
          </button>
        ))}
      </div>
      <Heading>Appearance</Heading>
      <div className="look-list">
        {LOOKS.map((look) => (
          <label key={look.id}>
            <input type="radio" name="aesthetic" checked={appearance.aesthetic === look.id} onChange={() => void save({ aesthetic: look.id })} />
            {look.label}
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
    </>
  );
}

export function UserSettings() {
  return (
    <Panel title="Your settings">
      <p className="hint">Color and appearance apply to your account.</p>
      <AppearanceFields />
    </Panel>
  );
}
