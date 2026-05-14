# Smooth Local-First Navigation Plan

## Goal

Make Taskara feel instant when moving between level-1 work surfaces: inbox, active issues, issue detail, knowledge base, projects, members, teams, announcements, meetings, and command search.

The product target is:

- Route changes should render from local data first, then reconcile quietly.
- Opening an item from a list should not blank the page or repeat slow resource fetches.
- Inbox, active issues, knowledge base navigation data, projects, teams, users, views, and useful counts should be bootstrapped on workspace load.
- Completed or canceled tasks older than 5 days should not be part of the default bootstrap. They should load only when a user opens an archive/history/search path that actually needs them.
- Writes should update local state immediately and sync in the background.
- The same data should power sidebar badges, command menu results, list rows, and detail pages so those surfaces do not drift.

## Current Research Findings

Taskara already has the beginning of the right system:

- `docs/local-first-task-sync-plan.md` defines the desired local-first task sync architecture.
- `apps/api/src/routes/sync.ts` already exposes `/sync/bootstrap`, `/sync/pull`, `/sync/push`, and `/sync/stream`.
- `apps/api/src/services/sync.ts` already has `WorkspaceSyncState`, `SyncEvent`, `ClientMutation`, an in-memory stream hub, and workspace cursor allocation.
- `apps/web/lib/task-sync.ts` already has IndexedDB snapshots, pending mutations, optimistic create/update/delete, `BroadcastChannel`, Web Locks, SSE consumption, periodic pull, and focus/online wakeups.
- `apps/api/src/services/tasks.ts` emits sync events for task create/update/delete/comment and uses `Task.version` plus changed fields for conflict detection.
- `apps/api/src/services/knowledge.ts` emits sync events for spaces and pages, but the web sync client treats non-task events as a task-sync refresh case instead of applying them to a shared knowledge cache.
- `apps/web/components/taskara/knowledge-view.tsx` still owns its own spaces/pages/page-detail state and refetches spaces, users, teams, projects, page lists, selected page, and comments separately.
- `apps/web/components/taskara/inbox-view.tsx` still owns notification state and detail state locally. Selecting a notification fetches task/announcement/meeting details on demand.
- `apps/web/components/taskara/issue-page.tsx` reads cached tasks from `WorkspaceTaskSyncProvider`, but still separately fetches task detail, users, projects, activity, and related docs.
- `apps/web/components/layout/main-layout.tsx` uses task sync data for command-menu issue/project/member/view results, but knowledge results are fetched remotely on every command query.
- The current task bootstrap loads up to 500 tasks for the scope without excluding completed/canceled tasks older than the desired 5-day hot window.

The implication: the task surface has partial local-first depth; other level-1 surfaces are still page-local and request-driven. Smooth navigation needs one workspace bootstrap/cache layer, not more page-specific fetch logic.

## Product Model

Treat the app as a workspace with three cache temperatures.

### Hot Bootstrap

Loaded on authenticated workspace shell mount and available before users choose a page:

- active tasks visible to the user;
- completed/canceled tasks with `completedAt` or fallback `updatedAt` within the last 5 days;
- inbox notification threads and unread counts;
- knowledge spaces and page summaries/tree metadata;
- projects, teams, users, saved views, labels, and workspace membership metadata;
- sidebar and command-menu counts;
- recently opened item snapshots;
- open outbox mutations and local drafts.

### Warm On-Demand

Fetched when a user is likely to need details, then retained locally:

- selected issue full detail: comments, activity, attachments, dependencies, related docs;
- selected inbox entity detail;
- selected knowledge page content, comments, versions metadata;
- selected announcement or meeting detail;
- nearby knowledge pages in the current tree;
- member/project/team detail panels.

### Cold Archive

Not bootstrapped by default:

- completed/canceled tasks older than 5 days;
- old notification pages beyond the first inbox window;
- archived knowledge pages;
- old page versions;
- long activity history;
- large attachment bodies or file blobs.

Cold data is reachable through explicit archive/history/search flows and paginated APIs.

## Data Loading Contract

Add a workspace-level bootstrap endpoint instead of making each route gather its own basics:

`GET /workspace/bootstrap?completedWindowDays=5`

Response shape:

```ts
type WorkspaceBootstrap = {
  cursor: string;
  serverTime: string;
  tasks: {
    hot: TaskaraTask[];
    omittedCompletedBefore: string;
    totalHot: number;
  };
  inbox: {
    items: TaskaraNotification[];
    unreadCount: number;
    cursor: string | null;
  };
  knowledge: {
    spaces: TaskaraKnowledgeSpace[];
    pageSummaries: TaskaraKnowledgePageSummary[];
  };
  resources: {
    projects: TaskaraProject[];
    teams: TaskaraTeam[];
    users: TaskaraUser[];
    views: TaskaraView[];
    labels: TaskaraLabel[];
  };
  counts: WorkspaceCounts;
};
```

Keep `/sync/bootstrap?scope=tasks` for compatibility while migrating, but the shell should eventually use the broader workspace bootstrap.

Task hot-scope rule:

```ts
status not in ('DONE', 'CANCELED')
OR coalesce(completedAt, updatedAt) >= now() - interval '5 days'
```

Do not rely on the UI filter alone. The server should enforce this omission in the default bootstrap so old completed work does not cost network, memory, startup time, command search ranking, or local selector work.

Add cold task APIs:

- `GET /tasks/archive?completedBefore=&cursor=&limit=`
- `GET /tasks/search?q=&includeArchived=true&limit=`
- `GET /tasks/:idOrKey` should still fetch an old completed task directly when opened by link.

## Client Architecture

Replace page-owned fetch state with a workspace data module under `apps/web/lib/workspace-data`.

Recommended modules:

- `workspace-db.ts`: IndexedDB schema for entities, detail records, cursors, scope completeness, drafts, outbox, and schema version.
- `workspace-store.ts`: `useSyncExternalStore` or Zustand-style normalized store for hot entities.
- `workspace-bootstrap.ts`: cache-first bootstrap, server refresh, stale cache reconciliation, auth/workspace reset.
- `workspace-sync.ts`: one stream and one pull loop for all entity types, not task-only sync plus page-level refresh events.
- `workspace-selectors.ts`: stable selectors for level-1 pages, command menu, sidebar badges, active issue lists, knowledge trees, inbox threads, and recently opened items.
- `workspace-mutators.ts`: optimistic mutations for tasks, notification read state, knowledge page summary edits, page comments, announcement reads, and meeting edits.
- `navigation-preload.ts`: intent-based preloading on hover, focus, keyboard highlight, command result highlight, and selected inbox row.

Store hot entities normalized:

```ts
type WorkspaceDataState = {
  cursor: string;
  syncStatus: 'loading' | 'ready' | 'syncing' | 'offline' | 'error';
  tasksById: Record<string, TaskaraTask>;
  taskKeyToId: Record<string, string>;
  omittedCompletedBefore: string;
  notificationThreadsById: Record<string, TaskaraNotification>;
  knowledgeSpacesById: Record<string, TaskaraKnowledgeSpace>;
  knowledgePageSummariesById: Record<string, TaskaraKnowledgePageSummary>;
  projectsById: Record<string, TaskaraProject>;
  teamsById: Record<string, TaskaraTeam>;
  usersById: Record<string, TaskaraUser>;
  viewsById: Record<string, TaskaraView>;
  detailCache: Record<string, DetailCacheEntry>;
  scopeCompleteness: Record<string, ScopeCompleteness>;
};
```

Keep detail records separate from list summaries. This lets a knowledge tree render instantly without bootstrapping every page body, every comment, and every version.

## Smooth Navigation Rules

1. Route transition renders immediately from the workspace store.
2. If a target detail exists in `detailCache`, show it immediately and revalidate in the background.
3. If only a summary exists, render the shell and summary immediately, then load detail into the existing layout without a full blank state.
4. If neither summary nor detail exists, show a stable skeleton in the final layout dimensions and fetch the item by id/key.
5. List scroll, selected row, keyboard highlight, active view, and return path are preserved per route/search key.
6. Changing route should never clear shared resources like users, projects, teams, views, or knowledge spaces.
7. Focus/online/visibility refresh should pull deltas, not refetch whole surfaces.
8. Sidebars and command menu read from the same selectors as pages.

## Inbox Plan

Bootstrap:

- first 50-100 collapsed inbox threads;
- unread thread count;
- lightweight linked entity snapshots for task, announcement, meeting, and knowledge page;
- notification sync cursor.

On selection:

- instantly show the linked snapshot;
- preload full detail for the highlighted/selected notification;
- mark read optimistically;
- sync read state in background;
- rollback read state only on hard failure.

Realtime:

- notification created/read events should be first-class sync event types;
- inbox applies notification events instead of relying on `dispatchWorkspaceRefresh`;
- unread counts are derived from local notification thread state or count events, not a separate race-prone fetch.

## Issues Plan

Bootstrap:

- all active visible tasks;
- completed/canceled tasks from the last 5 days;
- projects, users, teams, views, labels;
- task counts by status, assignee, project, and priority for complete hot scopes.

List:

- keep using local optimistic mutations;
- move array state toward normalized selectors to avoid repeated large array replacement;
- track whether a view is complete, partially searched, or archive-backed;
- show an "older completed tasks" affordance only when the current view requests completed work beyond the hot window.

Detail:

- issue page should consume the shared task entity as the base render;
- full detail fetch should only add comments, activity, dependencies, attachments, and related docs;
- comments should become sync events or scoped invalidations so list counts and detail timeline stay aligned.

## Knowledge Base Plan

Bootstrap:

- all accessible knowledge spaces;
- all non-archived page summaries: id, spaceId, parentId, path, title, owner, labels, verified state, updatedAt, child/comment/reference counts;
- no full page content bodies unless recently opened or pinned.

Navigation:

- tree renders from bootstrapped summaries instantly;
- selecting a page renders title/metadata immediately from summary;
- page content and comments load into the existing editor/reader area;
- prefetch page content on row hover, keyboard highlight, command result highlight, and adjacent tree expansion.

Sync:

- extend pull mapping for `knowledge_space`, `knowledge_page`, and `knowledge_page_comment`;
- page summary updates apply directly to the knowledge tree;
- selected page content updates reconcile only when the user has no unsaved local draft;
- if a remote update conflicts with a local draft, keep the draft and show a compact conflict state.

Draft safety:

- persist unsaved knowledge page drafts in IndexedDB keyed by workspace/page/version;
- autosave should enqueue or retry like other mutations, not disappear on route changes.

## Command Menu And Navigation Preload

The command menu should be a local-first navigation surface.

- Search hot issues, projects, users, teams, views, inbox threads, and knowledge page summaries locally.
- Only hit remote search when the query requires cold archive or full-text knowledge body search.
- When a command result is highlighted, preload its detail.
- When command opens an issue or page, route to a screen that already has the summary and usually has the detail.
- Add an explicit "Search archive" result when local hot search has no old completed task matches.

## Realtime And Sync Event Expansion

Evolve `/sync/pull` from task-scoped events to workspace-scoped events.

Recommended event families:

- `task`: create/update/delete/comment/attachment/label/dependency;
- `notification`: create/read/read_all/delete;
- `knowledge_space`: create/update/archive;
- `knowledge_page`: create/update/archive/verify/unverify/move/label;
- `knowledge_page_comment`: create/update/resolve;
- `project`, `team`, `user`, `view`, `announcement`, `meeting`: summary-level events where they affect level-1 navigation.

SSE should stay a wake-up signal. Payload correctness belongs to pull responses.

The app should have one stream leader per browser profile, one mutation flusher, and one broadcast channel. `IssuePage` should stop creating a separate pulse stream once workspace sync can notify all surfaces.

## UX Performance Targets

- Cached route-to-first-paint: under 100 ms.
- Local optimistic task mutation visual update: under 50 ms.
- Route to issue/page with bootstrapped summary: stable shell under 100 ms, detail under 500 ms on healthy network.
- Workspace bootstrap from warm IndexedDB cache: under 200 ms before server reconciliation.
- Workspace bootstrap from network for typical workspace: under 1.5 s.
- No layout reset on list-to-detail-to-list return.
- No full-surface spinner when data already exists locally.

## Rollout Plan

### Phase 1: Bootstrap Policy And Hot Task Scope

- Add the 5-day completed/canceled exclusion to `/sync/bootstrap`.
- Return `omittedCompletedBefore` and hot-scope metadata.
- Add archive/search endpoints for older completed tasks.
- Update task selectors and completed filters to know when older completed tasks are omitted.
- Add tests for hot bootstrap, old completed omission, direct old task fetch, and archive pagination.

### Phase 2: Workspace Bootstrap Store

- Introduce `workspace-data` modules.
- Move task sync state into the broader workspace store without changing UI behavior.
- Persist normalized resources and scope completeness in IndexedDB.
- Make `MainLayout`, sidebar, command menu, `TasksView`, `IssuePage`, and `HeartbeatView` read from shared selectors.

### Phase 3: Inbox Local-First

- Bootstrap inbox threads and unread count.
- Add notification sync events and apply them locally.
- Make mark-read and mark-all-read optimistic mutations.
- Prefetch selected inbox detail and avoid blank detail panes.

### Phase 4: Knowledge Local-First Navigation

- Bootstrap spaces and page summaries in the workspace store.
- Rewrite `KnowledgeView` to render tree and metadata from store selectors.
- Add detail cache for page content/comments.
- Add prefetch on hover/highlight.
- Persist page drafts and protect autosave conflicts.

### Phase 5: Unified Stream And Pull

- Extend pull mapping for non-task entity types.
- Replace page-level `useLiveRefresh` dependency with event application.
- Remove the separate issue pulse stream.
- Keep `dispatchWorkspaceRefresh` only as a dev/recovery bridge during migration.

### Phase 6: Polish And Measurement

- Add route transition instrumentation.
- Add sync debug panel in development.
- Add Playwright flows for list-to-detail return, inbox selection, wiki tree navigation, command-menu navigation, offline task edit, and old completed task archive loading.
- Add performance tests for 1,000 hot tasks, 5,000 knowledge summaries, and 100 inbox threads.

## Testing Checklist

- Workspace bootstrap excludes completed/canceled tasks older than 5 days.
- Active issues, inbox, and knowledge tree render from cached bootstrap while offline.
- Direct link to an old completed task loads the cold detail.
- "Show older completed" fetches archive data without polluting default hot bootstrap.
- Creating/updating/deleting a task updates list, detail, command menu, and counts without full reload.
- New inbox notification appears through sync and increments unread count.
- Mark-read works offline/pending and reconciles later.
- Knowledge page tree updates when a page is created, moved, renamed, verified, or archived.
- Selecting a knowledge page never clears spaces or the tree.
- Unsaved wiki draft survives route changes and reload.
- Two tabs share one stream leader and both receive updates.
- Switching workspace or logging out clears or namespaces all local data.

## Architectural Decision

Do not build separate local-first systems for each page. The deep module should be a workspace data module with a small interface:

- bootstrap workspace;
- select level-1 data;
- preload detail;
- mutate optimistically;
- pull/apply events;
- report sync status.

That gives Taskara the navigation feel users want because every level-1 surface reads from the same hot local graph, while old completed work and heavy history stay cold until the user asks for them.
