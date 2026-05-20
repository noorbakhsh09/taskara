import { useCallback, useEffect, useRef } from 'react';

export const workspaceRefreshEvent = 'taskara:workspace-refresh';

export type WorkspaceRefreshDetail = {
   origin?: string;
   source?: string;
};

type LiveRefreshOptions = {
   enabled?: boolean;
   fireOnMount?: boolean;
   ignoreWorkspaceEventOrigins?: string[];
   intervalMs?: number;
   minIntervalMs?: number;
   refreshOnFocus?: boolean;
   refreshOnInterval?: boolean;
   refreshOnOnline?: boolean;
   refreshOnPageShow?: boolean;
   refreshOnVisibility?: boolean;
   refreshOnWorkspaceEvent?: boolean;
   workspaceEventFilter?: (detail: WorkspaceRefreshDetail) => boolean;
};

export function dispatchWorkspaceRefresh(detail: WorkspaceRefreshDetail = {}) {
   if (typeof window === 'undefined') return;
   window.dispatchEvent(new CustomEvent(workspaceRefreshEvent, { detail }));
}

export function workspaceRefreshSourceMatches(detail: WorkspaceRefreshDetail, prefix: string): boolean {
   if (!detail.source) return true;
   return detail.source === prefix || detail.source.startsWith(`${prefix}:`);
}

export function useLiveRefresh(onRefresh: () => void | Promise<void>, options: LiveRefreshOptions = {}) {
   const {
      enabled = true,
      fireOnMount = true,
      ignoreWorkspaceEventOrigins = [],
      intervalMs = 60000,
      minIntervalMs = 1500,
      refreshOnFocus = false,
      refreshOnInterval = false,
      refreshOnOnline = true,
      refreshOnPageShow = true,
      refreshOnVisibility = false,
      refreshOnWorkspaceEvent = true,
      workspaceEventFilter,
   } = options;
   const onRefreshRef = useRef(onRefresh);
   const ignoredWorkspaceOriginsRef = useRef(ignoreWorkspaceEventOrigins);
   const workspaceEventFilterRef = useRef(workspaceEventFilter);
   const inFlightRef = useRef(false);
   const queuedRef = useRef(false);
   const lastRunRef = useRef(0);

   useEffect(() => {
      onRefreshRef.current = onRefresh;
   }, [onRefresh]);

   useEffect(() => {
      ignoredWorkspaceOriginsRef.current = ignoreWorkspaceEventOrigins;
      workspaceEventFilterRef.current = workspaceEventFilter;
   }, [ignoreWorkspaceEventOrigins, workspaceEventFilter]);

   const requestRefresh = useCallback(
      (force = false) => {
         if (!enabled) return;
         const now = Date.now();
         if (!force && now - lastRunRef.current < minIntervalMs) return;
         if (inFlightRef.current) {
            queuedRef.current = true;
            return;
         }

         inFlightRef.current = true;
         lastRunRef.current = now;
         void Promise.resolve(onRefreshRef.current())
            .catch(() => undefined)
            .finally(() => {
               inFlightRef.current = false;
               if (!queuedRef.current) return;
               queuedRef.current = false;
               requestRefresh(true);
            });
      },
      [enabled, minIntervalMs]
   );

   useEffect(() => {
      if (!enabled) return;

      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
         requestRefresh();
      };
      const handleWorkspaceRefresh = (event: Event) => {
         if (document.visibilityState === 'hidden') return;
         const detail = workspaceRefreshDetailFromEvent(event);
         if (detail.origin && ignoredWorkspaceOriginsRef.current.includes(detail.origin)) return;
         if (workspaceEventFilterRef.current && !workspaceEventFilterRef.current(detail)) return;
         requestRefresh(true);
      };
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) requestRefresh(true);
      };

      if (fireOnMount) requestRefresh(true);
      const interval = refreshOnInterval ? window.setInterval(handleWake, intervalMs) : null;
      if (refreshOnFocus) window.addEventListener('focus', handleWake);
      if (refreshOnOnline) window.addEventListener('online', handleWake);
      if (refreshOnPageShow) window.addEventListener('pageshow', handlePageShow);
      if (refreshOnWorkspaceEvent) window.addEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
      if (refreshOnVisibility) document.addEventListener('visibilitychange', handleWake);

      return () => {
         if (interval) window.clearInterval(interval);
         if (refreshOnFocus) window.removeEventListener('focus', handleWake);
         if (refreshOnOnline) window.removeEventListener('online', handleWake);
         if (refreshOnPageShow) window.removeEventListener('pageshow', handlePageShow);
         if (refreshOnWorkspaceEvent) window.removeEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
         if (refreshOnVisibility) document.removeEventListener('visibilitychange', handleWake);
      };
   }, [
      enabled,
      fireOnMount,
      intervalMs,
      refreshOnFocus,
      refreshOnInterval,
      refreshOnOnline,
      refreshOnPageShow,
      refreshOnVisibility,
      refreshOnWorkspaceEvent,
      requestRefresh,
   ]);
}

function workspaceRefreshDetailFromEvent(event: Event): WorkspaceRefreshDetail {
   if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') return {};
   const detail = event.detail as WorkspaceRefreshDetail;
   return {
      origin: typeof detail.origin === 'string' ? detail.origin : undefined,
      source: typeof detail.source === 'string' ? detail.source : undefined,
   };
}
