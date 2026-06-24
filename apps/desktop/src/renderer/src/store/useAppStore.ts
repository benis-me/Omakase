import { create } from 'zustand';
import type { ActiveWorkspace, AppSettings, ThemeMode, WorkspaceInfo } from '@shared/types';

export type NavSection = 'runs' | 'specs' | 'agents' | 'memory' | 'workflows' | 'dev';

const api = (): typeof window.omakase => window.omakase;

interface AppState {
  ready: boolean;
  workspaces: WorkspaceInfo[];
  active: ActiveWorkspace | null;
  settings: AppSettings | null;
  nav: NavSection;
  paletteOpen: boolean;

  init: () => Promise<void>;
  setNav: (nav: NavSection) => void;
  setPaletteOpen: (open: boolean) => void;

  browseAndAdd: () => Promise<void>;
  createWorkspace: (parentDir: string, name: string) => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  closeWorkspace: () => Promise<void>;
  removeWorkspace: (path: string) => Promise<void>;
  reorderWorkspaces: (paths: string[]) => Promise<void>;
  setPinned: (path: string, pinned: boolean) => Promise<void>;

  setTheme: (theme: ThemeMode) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  workspaces: [],
  active: null,
  settings: null,
  nav: 'runs',
  paletteOpen: false,

  init: async () => {
    const [workspaces, active, settings] = await Promise.all([
      api().workspaces.list(),
      api().workspaces.active(),
      api().settings.get(),
    ]);
    set({ workspaces, active, settings, ready: true });

    api().onWorkspacesChanged((list) => set({ workspaces: list }));
    api().onActiveWorkspaceChanged((ws) => set({ active: ws }));
    api().onSettingsChanged((s) => set({ settings: s }));
  },

  setNav: (nav) => set({ nav }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  browseAndAdd: async () => {
    const folder = await api().workspaces.pickFolder();
    if (!folder) return;
    const active = await api().workspaces.add(folder);
    set({ active });
  },

  createWorkspace: async (parentDir, name) => {
    const active = await api().workspaces.create(parentDir, name);
    set({ active });
  },

  openWorkspace: async (path) => {
    const active = await api().workspaces.open(path);
    set({ active });
  },

  closeWorkspace: async () => {
    await api().workspaces.close();
    set({ active: null });
  },

  removeWorkspace: async (path) => {
    const workspaces = await api().workspaces.remove(path);
    set({ workspaces });
  },

  reorderWorkspaces: async (paths) => {
    // optimistic: reorder locally, then persist
    const byPath = new Map(get().workspaces.map((w) => [w.path, w]));
    const reordered = paths.map((p) => byPath.get(p)).filter((w): w is WorkspaceInfo => Boolean(w));
    set({ workspaces: reordered });
    const workspaces = await api().workspaces.reorder(paths);
    set({ workspaces });
  },

  setPinned: async (path, pinned) => {
    const workspaces = await api().workspaces.setPinned(path, pinned);
    set({ workspaces });
  },

  setTheme: async (theme) => {
    const settings = await api().settings.set({ theme });
    set({ settings });
  },
}));
