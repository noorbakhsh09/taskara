import type { ReactNode } from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { taskaraRequest } from '@/lib/taskara-client';
import { dispatchWorkspaceRefresh, workspaceRefreshEvent } from '@/lib/live-refresh';
import type { NotificationSyncResponse, NotificationsResponse, TaskaraNotification } from '@/lib/taskara-types';

type InboxSnapshot = {
   cursor: string | null;
   items: TaskaraNotification[];
   savedAt: string;
   unreadCount: number;
};

type InboxSyncState = {
   cursor: string | null;
   items: TaskaraNotification[];
   loading: boolean;
   error: string;
   unreadCount: number;
};

const inboxCachePrefix = 'taskara.inbox.v1:';
const inboxSyncIntervalMs = 60000;

export type InboxSyncController = ReturnType<typeof useInboxSync>;

const InboxSyncContext = createContext<InboxSyncController | null>(null);

export function WorkspaceInboxSyncProvider({
   children,
   workspaceSlug,
}: {
   children: ReactNode;
   workspaceSlug: string;
}) {
   const controller = useInboxSync(workspaceSlug);
   return createElement(InboxSyncContext.Provider, { value: controller }, children);
}

export function useWorkspaceInboxSync(): InboxSyncController {
   const sync = useContext(InboxSyncContext);
   if (!sync) throw new Error('useWorkspaceInboxSync must be used inside WorkspaceInboxSyncProvider.');
   return sync;
}

function useInboxSync(workspaceSlug: string) {
   const cacheKey = useMemo(() => `${inboxCachePrefix}${workspaceSlug}`, [workspaceSlug]);
   const [state, setState] = useState<InboxSyncState>({
      cursor: null,
      items: [],
      loading: true,
      error: '',
      unreadCount: 0,
   });

   const saveSnapshot = useCallback(
      (snapshot: Omit<InboxSnapshot, 'savedAt'>) => {
         if (typeof window === 'undefined') return;
         try {
            window.localStorage.setItem(
               cacheKey,
               JSON.stringify({
                  ...snapshot,
                  savedAt: new Date().toISOString(),
               } satisfies InboxSnapshot)
            );
         } catch {
            // Cache writes are best effort. Network remains authoritative.
         }
      },
      [cacheKey]
   );

   const applySnapshot = useCallback(
      (snapshot: Omit<InboxSnapshot, 'savedAt'>, loading = false) => {
         setState({
            cursor: snapshot.cursor,
            items: snapshot.items,
            loading,
            error: '',
            unreadCount: snapshot.unreadCount,
         });
         saveSnapshot(snapshot);
      },
      [saveSnapshot]
   );

   const refresh = useCallback(async () => {
      setState((current) => ({ ...current, loading: current.items.length === 0, error: '' }));
      try {
         const result = await taskaraRequest<NotificationsResponse>('/notifications?limit=100');
         applySnapshot({
            cursor: cursorFromNotifications(result.items),
            items: result.items,
            unreadCount: result.unreadCount,
         });
      } catch (err) {
         setState((current) => ({
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : 'Inbox sync failed.',
         }));
      }
   }, [applySnapshot]);

   const sync = useCallback(async () => {
      const cursor = state.cursor;
      if (!cursor) {
         await refresh();
         return;
      }

      try {
         const params = new URLSearchParams({ after: cursor, limit: '100' });
         const result = await taskaraRequest<NotificationSyncResponse>(`/notifications/sync?${params.toString()}`);
         setState((current) => {
            const items = mergeInboxNotifications(current.items, result.items);
            const next = {
               cursor: result.nextCursor || current.cursor,
               items,
               loading: false,
               error: '',
               unreadCount: result.unreadCount,
            };
            saveSnapshot(next);
            return next;
         });
      } catch (err) {
         setState((current) => ({
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : 'Inbox sync failed.',
         }));
      }
   }, [refresh, saveSnapshot, state.cursor]);

   useEffect(() => {
      let restored = false;
      try {
         const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(cacheKey);
         const snapshot = raw ? JSON.parse(raw) : null;
         if (isInboxSnapshot(snapshot)) {
            restored = true;
            setState({
               cursor: snapshot.cursor,
               items: snapshot.items,
               loading: false,
               error: '',
               unreadCount: snapshot.unreadCount,
            });
         }
      } catch {
         // Ignore corrupted cache and rehydrate from the API.
      }

      if (!restored) {
         setState((current) => ({ ...current, loading: true }));
      }
      void refresh();
   }, [cacheKey, refresh]);

   useEffect(() => {
      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
         void sync();
      };
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) void sync();
      };
      const handleAuthChanged = () => void refresh();
      const interval = window.setInterval(handleWake, inboxSyncIntervalMs);

      window.addEventListener('online', handleWake);
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener('taskara:auth-changed', handleAuthChanged);
      window.addEventListener(workspaceRefreshEvent, handleWake);
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('online', handleWake);
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener('taskara:auth-changed', handleAuthChanged);
         window.removeEventListener(workspaceRefreshEvent, handleWake);
      };
   }, [refresh, sync]);

   const markRead = useCallback(
      async (notification: TaskaraNotification) => {
         if (notification.readAt) return;
         const previous = state;
         const readAt = new Date().toISOString();
         const nextItems = state.items.map((item) =>
            sameNotificationThread(item, notification) ? { ...item, readAt: item.readAt || readAt } : item
         );
         const nextUnreadCount = Math.max(0, state.unreadCount - 1);
         setState((current) => ({
            ...current,
            items: nextItems,
            unreadCount: nextUnreadCount,
         }));
         saveSnapshot({ cursor: state.cursor, items: nextItems, unreadCount: nextUnreadCount });

         try {
            await taskaraRequest(`/notifications/${notification.id}/read`, { method: 'PATCH' });
            dispatchWorkspaceRefresh({ source: 'notifications:read' });
         } catch (err) {
            setState({
               ...previous,
               error: err instanceof Error ? err.message : 'Failed to mark notification as read.',
            });
            saveSnapshot(previous);
         }
      },
      [saveSnapshot, state]
   );

   const markAllRead = useCallback(async () => {
      const previous = state;
      const readAt = new Date().toISOString();
      const nextItems = state.items.map((item) => ({ ...item, readAt: item.readAt || readAt }));
      setState((current) => ({
         ...current,
         items: nextItems,
         unreadCount: 0,
      }));
      saveSnapshot({ cursor: state.cursor, items: nextItems, unreadCount: 0 });

      try {
         await taskaraRequest('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
         dispatchWorkspaceRefresh({ source: 'notifications:read-all' });
      } catch (err) {
         setState({
            ...previous,
            error: err instanceof Error ? err.message : 'Failed to mark notifications as read.',
         });
         saveSnapshot(previous);
      }
   }, [saveSnapshot, state]);

   return {
      error: state.error,
      loading: state.loading,
      markAllRead,
      markRead,
      notifications: state.items,
      refresh,
      sync,
      unreadCount: state.unreadCount,
   };
}

function mergeInboxNotifications(current: TaskaraNotification[], incoming: TaskaraNotification[]): TaskaraNotification[] {
   if (incoming.length === 0) return current;

   const byThread = new Map<string, TaskaraNotification>();
   for (const item of current) byThread.set(notificationThreadKey(item), item);

   for (const item of incoming) {
      const key = notificationThreadKey(item);
      const existing = byThread.get(key);
      if (!existing || compareNotificationsByRecency(item, existing) < 0) {
         byThread.set(key, item);
      } else if (!item.readAt && existing.readAt) {
         byThread.set(key, { ...existing, readAt: null });
      }
   }

   return [...byThread.values()].sort(compareNotificationsByRecency).slice(0, 100);
}

function cursorFromNotifications(items: TaskaraNotification[]): string | null {
   const latest = [...items].sort(compareNotificationsByRecency)[0];
   return latest ? `${latest.createdAt}|${latest.id}` : null;
}

function compareNotificationsByRecency(left: TaskaraNotification, right: TaskaraNotification): number {
   const leftTime = Date.parse(left.createdAt) || 0;
   const rightTime = Date.parse(right.createdAt) || 0;
   if (leftTime !== rightTime) return rightTime - leftTime;
   return right.id.localeCompare(left.id);
}

function sameNotificationThread(left: TaskaraNotification, right: TaskaraNotification): boolean {
   return notificationThreadKey(left) === notificationThreadKey(right);
}

function notificationThreadKey(notification: TaskaraNotification): string {
   if (notification.task?.id) return `task:${notification.task.id}`;
   if (notification.announcement?.id) return `announcement:${notification.announcement.id}`;
   if (notification.meeting?.id) return `meeting:${notification.meeting.id}`;
   if (notification.knowledgePage?.id) return `knowledge:${notification.knowledgePage.id}`;
   return `notification:${notification.id}`;
}

function isInboxSnapshot(value: unknown): value is InboxSnapshot {
   if (!value || typeof value !== 'object') return false;
   const snapshot = value as Partial<InboxSnapshot>;
   return (
      (snapshot.cursor === null || typeof snapshot.cursor === 'string') &&
      typeof snapshot.savedAt === 'string' &&
      Array.isArray(snapshot.items) &&
      typeof snapshot.unreadCount === 'number'
   );
}
