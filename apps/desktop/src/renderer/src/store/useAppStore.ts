import { create } from 'zustand';
import { toast } from 'sonner';
import type {
  ActiveWorkspace,
  AppInfo,
  AppSettings,
  CockpitEvent,
  GitInfo,
  ProjectInfo,
  RunControl,
  RunSummaryDto,
  ScriptSession,
  ThemeMode,
  WorkspaceInfo,
} from '@shared/types';

export type NavSection = 'runs' | 'specs' | 'agents' | 'memory' | 'workflows' | 'dev';

const api = (): typeof window.omakase => window.omakase;

// Guard against double-subscription under React StrictMode's double-invoked effects.
let booted = false;

interface AppState {
  ready: boolean;
  workspaces: WorkspaceInfo[];
  active: ActiveWorkspace | null;
  settings: AppSettings | null;
  nav: NavSection;
  paletteOpen: boolean;

  // Dev workbench slice
  projects: ProjectInfo[];
  sessions: Record<string, ScriptSession>;
  selectedTerminal: string | null;
  gitInfo: GitInfo | null;
  apps: AppInfo[];

  // Runs cockpit slice
  runs: RunSummaryDto[];
  currentRunId: string | null;
  feed: CockpitEvent[];

  init: () => Promise<void>;
  setNav: (nav: NavSection) => void;
  setPaletteOpen: (open: boolean) => void;

  loadRuns: () => Promise<void>;
  openRun: (id: string) => Promise<void>;
  closeRun: () => void;
  startRun: (input: {
    prompt?: string;
    specId?: string;
    mode?: AppSettings['defaultMode'];
    autonomy?: AppSettings['defaultAutonomy'];
  }) => Promise<void>;
  resumeRun: (id: string) => Promise<void>;
  startWorkflow: (workflowId: string) => Promise<void>;
  controlRun: (command: RunControl) => Promise<void>;
  deleteRun: (id: string) => Promise<void>;

  scanDev: () => Promise<void>;
  startScript: (id: string) => Promise<void>;
  stopScript: (id: string) => Promise<void>;
  restartScript: (id: string) => Promise<void>;
  selectTerminal: (id: string | null) => void;
  loadGit: () => Promise<void>;
  killPortAndRestart: (id: string, port: number) => Promise<void>;

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

  projects: [],
  sessions: {},
  selectedTerminal: null,
  gitInfo: null,
  apps: [],

  runs: [],
  currentRunId: null,
  feed: [],

  init: async () => {
    if (booted) return;
    booted = true;
    const [workspaces, active, settings] = await Promise.all([
      api().workspaces.list(),
      api().workspaces.active(),
      api().settings.get(),
    ]);
    set({ workspaces, active, settings, ready: true });

    api().onWorkspacesChanged((list) => set({ workspaces: list }));
    api().onActiveWorkspaceChanged((ws) =>
      set({
        active: ws,
        projects: [],
        sessions: {},
        selectedTerminal: null,
        gitInfo: null,
        runs: [],
        currentRunId: null,
        feed: [],
      }),
    );
    api().onSettingsChanged((s) => set({ settings: s }));

    api().onProjectsUpdated((projects) => set({ projects }));
    api().onScriptStatus((session) =>
      set((s) => ({ sessions: { ...s.sessions, [session.id]: session } })),
    );
    api().onScriptUrl(({ id, url }) =>
      set((s) => {
        const prev = s.sessions[id];
        return prev ? { sessions: { ...s.sessions, [id]: { ...prev, url } } } : {};
      }),
    );
    api().onPortConflict(({ id, port }) => {
      const name = get().projects.flatMap((p) => p.scripts).find((s) => s.id === id)?.name ?? id;
      toast.error(`Port ${port} is already in use (${name})`, {
        action: { label: 'Free & restart', onClick: () => void get().killPortAndRestart(id, port) },
      });
    });

    api().onRunEvent(({ runId, event }) => {
      if (runId === get().currentRunId) set((s) => ({ feed: [...s.feed, event] }));
    });
    api().onRunStatus(() => void get().loadRuns());

    void api().apps.list().then((apps) => set({ apps }));
    if (active) void get().scanDev();
  },

  setNav: (nav) => set({ nav }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  scanDev: async () => {
    const [projects, sessions] = await Promise.all([api().dev.scan(), api().scripts.sessions()]);
    const byId: Record<string, ScriptSession> = {};
    for (const s of sessions) byId[s.id] = s;
    set({ projects, sessions: byId });
    void get().loadGit();
  },

  loadGit: async () => {
    set({ gitInfo: await api().git.status() });
  },

  killPortAndRestart: async (id, port) => {
    await api().ports.kill(port);
    await get().restartScript(id);
  },

  loadRuns: async () => {
    set({ runs: await api().runs.list() });
  },
  openRun: async (id) => {
    const detail = await api().runs.get(id);
    set({ currentRunId: id, feed: detail?.events ?? [] });
  },
  closeRun: () => set({ currentRunId: null, feed: [] }),
  startRun: async (input) => {
    const settings = get().settings;
    const id = await api().runs.start({
      mode: input.mode ?? settings?.defaultMode ?? 'normal',
      autonomy: input.autonomy ?? settings?.defaultAutonomy ?? 'low',
      prompt: input.prompt,
      specId: input.specId,
    });
    set({ currentRunId: id, feed: [] });
    void get().loadRuns();
  },
  resumeRun: async (id) => {
    const autonomy = get().settings?.defaultAutonomy ?? 'low';
    await api().runs.resume(id, autonomy);
    await get().openRun(id);
    void get().loadRuns();
  },
  startWorkflow: async (workflowId) => {
    const autonomy = get().settings?.defaultAutonomy ?? 'low';
    try {
      const runId = await api().runs.startWorkflow(workflowId, autonomy);
      set({ nav: 'runs', currentRunId: runId, feed: [] });
      void get().loadRuns();
    } catch (err) {
      toast.error(`Could not start workflow: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  controlRun: async (command) => {
    const id = get().currentRunId;
    if (id) await api().runs.control(id, command);
  },
  deleteRun: async (id) => {
    await api().runs.delete(id);
    if (get().currentRunId === id) set({ currentRunId: null, feed: [] });
    void get().loadRuns();
  },

  startScript: async (id) => {
    set({ selectedTerminal: id });
    await api().scripts.start(id);
  },
  stopScript: async (id) => {
    await api().scripts.stop(id);
  },
  restartScript: async (id) => {
    set({ selectedTerminal: id });
    await api().scripts.restart(id);
  },
  selectTerminal: (id) => set({ selectedTerminal: id }),

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
