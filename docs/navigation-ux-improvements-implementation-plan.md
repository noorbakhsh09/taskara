# Navigation UX Improvements Implementation Plan

## Goal

Remove the remaining sources of navigation jumps and make Taskara feel local-first across active issues, inbox, knowledge base, and command navigation.

This plan continues from `docs/smooth-local-first-navigation-plan.md` and assumes the first slice is already implemented:

- default task bootstrap omits completed/canceled tasks older than 5 days;
- old completed tasks can load through `/tasks/archive`;
- generic `useLiveRefresh` no longer refetches whole pages on window focus/visibility.

## Principles

- Never clear visible content during a background refresh.
- Prefer delta pull over full bootstrap.
- Use cached summaries for route transitions, then load detail in place.
- Keep hot data complete enough for level-1 navigation.
- Treat archive/history data as cold and explicitly paginated.
- Use one shared workspace data source where possible instead of page-owned fetch state.

## Phase 1: Make Task Sync Recovery Non-Jumpy

### Problem

`apps/web/lib/task-sync.ts` mostly handles active-window wakeups correctly through `flushPendingTaskSyncMutations()` and `pull()`. The jump risk is the fallback path:

- `pull()` calls `refresh()` for unrecoverable errors;
- `pull()` calls `refresh()` when it sees non-task sync events;
- `refresh()` can clear `tasks` and resources when scope changes or cache/server data arrives in a different order.

Normal wakeups should not visually replace the task list.

### Implementation

1. Add a soft recovery mode to `refresh()`:
   - `refresh({ preserveVisibleState: true })`
   - does not clear `tasks` or `resources`;
   - applies bootstrap only after data arrives;
   - preserves stable order by keeping existing task ids where possible.

2. Change `pull()` fallback behavior:
   - for non-task events, dispatch targeted workspace refresh only for affected surfaces, or ignore until workspace-wide sync exists;
   - for transient parse/network errors, keep visible state and set sync status/error;
   - only hard reset when `resetRequired`, auth/workspace changes, schema mismatch, or explicit user refresh.

3. Add explicit sync status:
   - `syncStatus: 'loading' | 'ready' | 'syncing' | 'offline' | 'recovering' | 'error'`
   - expose this from `useWorkspaceTaskSync`.

4. Do not run a full bootstrap on focus/visibility.
   - Keep focus/online wake as `flushPending -> pull`.
   - If pull fails, keep current rows.

### Files

- `apps/web/lib/task-sync.ts`
- `apps/web/lib/task-sync-provider.tsx`
- `apps/web/components/taskara/tasks-view.tsx`
- optionally `apps/web/components/taskara/page-header.tsx` for small sync indicator

### Acceptance Criteria

- Returning to an open issue list does not clear or reorder rows unless actual task data changed.
- Pull failures show a subtle stale/error state but keep the current list.
- `resetRequired` still performs a real bootstrap.
- Manual refresh still works as a hard recovery command.

### Verification

- Web typecheck.
- Add unit tests around task merge/order helpers if extracted.
- Manual flow: scroll issue list, switch away, return to window, verify scroll and row positions stay stable.

## Phase 2: Stabilize Completed Archive Loading

### Problem

`TasksView` currently loads only the first 100 old completed tasks when a view needs completed work. This is useful, but incomplete and can still cause jumps if archive rows are replaced.

### Implementation

1. Add archive state per scope/view:

```ts
type TaskArchiveState = {
  items: TaskaraTask[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  complete: boolean;
  requestKey: string;
};
```

2. Build archive request key from:
   - workspace slug;
   - team slug;
   - mine/all;
   - completed setting;
   - query/status/priority/project/assignee filters where relevant.

3. Preserve existing archive rows while loading the next page.

4. Add "load older completed" pagination affordance:
   - auto-load first archive page only when completed setting requires it;
   - manual load-more for more pages;
   - show compact loading row at the bottom.

5. Apply filters server-side when possible:
   - `q`, `teamId`, `mine`, `assigneeId`, `priority`, `projectId`;
   - consider adding `status=DONE|CANCELED` if users need that distinction.

6. Merge archive and hot rows by id without changing hot row precedence.

### Files

- `apps/api/src/routes/tasks.ts`
- `apps/web/components/taskara/tasks-view.tsx`
- maybe `apps/web/lib/taskara-types.ts` for `ArchivedTasksResponse`

### Acceptance Criteria

- Views requesting completed work show hot tasks immediately.
- Old completed tasks append without replacing the visible list.
- Load-more works until `nextCursor` is null.
- Changing filters resets only the archive slice for that request key.
- Returning to the window does not re-fetch archive pages unless the request key changed.

### Verification

- API typecheck.
- Web typecheck.
- Add route tests for `/tasks/archive` query combinations if API test harness exists.
- Manual flow with more than 100 completed tasks.

## Phase 3: Inbox Local-First Threads And Read State

### Problem

`InboxView` still fetches `/notifications` into page-local state. Selecting an item fetches entity detail. Mark-read is optimistic, but the inbox list still depends on page-level refetches.

### Implementation

1. Add notification summary cache:
   - store collapsed notification threads;
   - unread thread count;
   - notification cursor from `/notifications/sync`.

2. Bootstrap inbox summaries on workspace load:
   - initially this can live in a small `inbox-sync.ts` module;
   - later move into a full workspace bootstrap store.

3. Make `InboxView` render from cache first:
   - list appears immediately from cached threads;
   - selected thread shows linked entity snapshot first;
   - detail loads into the right pane without clearing the list.

4. Optimistic read mutations:
   - `markRead(notificationId)`;
   - `markAllRead()`;
   - persist pending read mutations if reasonable, or retry on next online/focus wake.

5. Add notification sync events or polling bridge:
   - best: emit `notification` sync events in server notification writes;
   - interim: call `/notifications/sync?after=cursor` on stream pulse/interval.

6. Remove generic `useLiveRefresh(load)` from inbox once cache sync exists.

### Files

- `apps/web/components/taskara/inbox-view.tsx`
- `apps/web/lib/inbox-sync.ts` or `apps/web/lib/workspace-data/*`
- `apps/api/src/routes/notifications.ts`
- `apps/api/src/services/notifications.ts`
- `apps/api/src/services/sync.ts` if adding sync events

### Acceptance Criteria

- Inbox list does not blank on focus, route changes, or read actions.
- Mark-read updates immediately and survives a failed transient request.
- New notifications appear without a full reload.
- Unread count remains consistent with collapsed thread semantics.

### Verification

- Web typecheck.
- API typecheck if server events are added.
- Manual: open inbox, select item, mark read, switch windows, return, verify no list jump.

## Phase 4: Knowledge Base Summary Bootstrap

### Problem

`KnowledgeView` owns spaces/pages/detail state and fetches spaces, users, teams, projects, pages, selected page, and comments. Moving between wiki pages can show loading states and re-request data that should already be hot.

### Implementation

1. Define page summary type:

```ts
type TaskaraKnowledgePageSummary = Omit<TaskaraKnowledgePage, 'content' | 'contentText' | 'attachments'> & {
  content?: never;
  contentText?: string;
};
```

2. Add API support for summaries:
   - either `GET /knowledge/pages?summary=true`;
   - or dedicated `GET /knowledge/page-summaries`.

3. Bootstrap/cache:
   - accessible spaces;
   - all non-archived page summaries;
   - owners, labels, verification state, counts, parent/path data.

4. Rewrite `KnowledgeView` tree to render from summaries:
   - tree and metadata render immediately;
   - selected page title/owner/labels show from summary;
   - page body/comments load as warm detail.

5. Add detail cache:
   - key by `workspaceId:pageId`;
   - stale-while-revalidate behavior;
   - do not clear current editor while revalidating.

6. Draft persistence:
   - save unsaved title/content/labels locally by `pageId + version`;
   - restore drafts on route return;
   - if remote version changes, keep draft and show conflict notice.

7. Prefetch:
   - page row hover;
   - keyboard highlight;
   - command-menu result highlight;
   - adjacent pages when expanding a tree node.

### Files

- `apps/api/src/routes/knowledge.ts`
- `apps/api/src/services/knowledge.ts`
- `apps/web/components/taskara/knowledge-view.tsx`
- `apps/web/lib/taskara-types.ts`
- new `apps/web/lib/knowledge-cache.ts` or workspace-data module

### Acceptance Criteria

- Wiki spaces and tree render without waiting for page detail fetch.
- Selecting a page does not clear the tree.
- Revalidating selected page does not clear editor content.
- Unsaved drafts survive route changes and reload.
- Remote conflict does not overwrite local unsaved edits.

### Verification

- API typecheck.
- Web typecheck.
- Manual: navigate quickly between wiki pages; verify tree and metadata stay stable.

## Phase 5: Route-Intent Prefetch

### Problem

The app often waits until a click/route transition before fetching detail. The detail request should usually start before the user commits.

### Implementation

1. Create `navigation-preload.ts`:
   - `preloadIssue(idOrKey)`;
   - `preloadKnowledgePage(pageId)`;
   - `preloadInboxThread(notificationId)`;
   - dedupe in-flight requests;
   - short TTL cache for preloaded details.

2. Trigger preload from:
   - issue row hover/focus;
   - issue keyboard highlighted row;
   - wiki page tree hover/focus;
   - inbox selected/hovered row;
   - command-menu highlighted result.

3. Detail pages consume preload cache before network.

### Files

- `apps/web/lib/navigation-preload.ts`
- `apps/web/components/taskara/tasks-view.tsx`
- `apps/web/components/taskara/issue-page.tsx`
- `apps/web/components/taskara/knowledge-view.tsx`
- `apps/web/components/taskara/inbox-view.tsx`
- `apps/web/components/layout/main-layout.tsx`

### Acceptance Criteria

- Hovering or keyboard-highlighting an item starts a detail fetch once.
- Opening that item uses the preloaded result.
- Preload failures do not show user-facing errors.
- No duplicate requests for the same detail while one is in flight.

### Verification

- Web typecheck.
- Browser/network manual check for dedupe and timing.

## Phase 6: Shared Workspace Data Module

### Problem

Tasks, inbox, knowledge, projects, members, and command menu still use separate data owners. This creates drift and makes it easy to reintroduce page-level jumps.

### Implementation

1. Add `apps/web/lib/workspace-data`.

Recommended modules:

- `workspace-db.ts`
- `workspace-store.ts`
- `workspace-bootstrap.ts`
- `workspace-sync.ts`
- `workspace-selectors.ts`
- `workspace-mutators.ts`
- `workspace-detail-cache.ts`

2. Move existing task sync into this module first, preserving public hook compatibility.

3. Add inbox summaries and knowledge summaries to the same store.

4. Update consumers incrementally:
   - `MainLayout` command menu;
   - `AppSidebar`;
   - `TasksView`;
   - `IssuePage`;
   - `InboxView`;
   - `KnowledgeView`.

5. Replace `dispatchWorkspaceRefresh` with entity-aware invalidation:

```ts
invalidateWorkspaceEntities([
  { type: 'task', id },
  { type: 'knowledge_page', id },
]);
```

6. Keep `dispatchWorkspaceRefresh` only as a temporary bridge.

### Acceptance Criteria

- One bootstrap path owns level-1 hot data.
- Command menu, sidebar, lists, and details read from the same store.
- Page-level fetches become warm detail fetches, not full surface owners.
- No active-window jump caused by generic page refresh.

### Verification

- Web typecheck after each migrated surface.
- Manual end-to-end navigation flows after every migration.
- Add Playwright coverage once Browser tooling is wired for the local app.

## Phase 7: Measurement And Guardrails

### Implementation

1. Add development-only navigation metrics:
   - route transition start/end;
   - cache hit/miss;
   - bootstrap duration;
   - pull duration;
   - list row count before/after background refresh;
   - scroll position before/after route return.

2. Add a debug panel:
   - sync cursor;
   - sync status;
   - pending mutations;
   - last pull time;
   - detail cache entries;
   - archive loaded count.

3. Add regression checks:
   - no full list clear on focus;
   - no scroll jump after focus;
   - list-to-detail-to-list preserves row and scroll;
   - wiki tree remains visible while page detail loads;
   - inbox selected row remains stable while read state syncs.

### Acceptance Criteria

- We can see when a background refresh changes row count or scroll.
- A regression in active-window jumps is easy to reproduce and verify.
- Debug instrumentation is development-only.

## Recommended Execution Order

1. Phase 1: task sync soft recovery.
2. Phase 2: archive pagination and stable merge.
3. Phase 3: inbox local-first cache.
4. Phase 4: knowledge summary bootstrap.
5. Phase 5: route-intent prefetch.
6. Phase 6: shared workspace data module.
7. Phase 7: metrics and guardrails.

The first two phases are the fastest path to removing visible jumps in the current issue list. Phases 3 and 4 bring inbox and knowledge base up to the same standard. Phase 6 is the architectural consolidation that prevents this class of problem from returning.
