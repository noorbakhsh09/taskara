import { describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@taskara/db';
import { mapSyncEventForScope } from './sync';
import { syncCursor } from '../services/sync';
import type { RequestActor } from '../services/actor';

const actor = {
  workspace: { id: 'workspace-1' },
  user: { id: 'user-1' },
  role: 'MEMBER'
} as RequestActor;

const baseEvent = {
  id: 'event-1',
  workspaceId: 'workspace-1',
  workspaceSeq: BigInt(7),
  entityType: 'task',
  entityId: 'task-1',
  operation: 'updated',
  entityVersion: 2,
  actorId: 'user-2',
  clientId: null,
  mutationId: null,
  createdAt: new Date('2026-04-26T00:00:00.000Z')
} satisfies Omit<SyncEvent, 'payload'>;

describe('sync event scope mapping', () => {
  test('upserts tasks that move into scope', () => {
    const event = syncEvent({
      before: task({ assignee: { id: 'user-2' } }),
      after: task({ assignee: { id: 'user-1' } })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
    expect(mapped && 'task' in mapped ? mapped.task?.id : null).toBe('task-1');
  });

  test('removes tasks that move out of scope without deleting globally', () => {
    const event = syncEvent({
      before: task({ assignee: { id: 'user-1' } }),
      after: task({ assignee: { id: 'user-2' } })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('removeFromScope');
    expect(mapped && 'taskId' in mapped ? mapped.taskId : null).toBe('task-1');
  });

  test('deletes visible tasks when delete tombstone arrives', () => {
    const event = syncEvent({ before: task({ assignee: { id: 'user-1' } }) }, 'deleted');

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('delete');
    expect(mapped && 'taskKey' in mapped ? mapped.taskKey : null).toBe('CORE-1');
  });

  test('filters events that are outside the requested team scope', () => {
    const event = syncEvent({ after: task({ project: { team: { slug: 'eng' } } }) });

    const mapped = mapSyncEventForScope(event, syncQuery({ teamId: 'ops' }), actor, null);

    expect(mapped).toBeNull();
  });

  test('filters completed tasks outside the hot bootstrap window', () => {
    const event = syncEvent({
      after: task({
        status: 'DONE',
        completedAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ completedWindowDays: 5 }), actor, null);

    expect(mapped).toBeNull();
  });

  test('keeps recently completed tasks in the hot bootstrap window', () => {
    const event = syncEvent({
      after: task({
        status: 'DONE',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ completedWindowDays: 5 }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });
});

describe('sync cursor serialization', () => {
  test('serializes bigint cursors as decimal strings', () => {
    expect(syncCursor(BigInt('9007199254740993'))).toBe('9007199254740993');
  });

  test('normalizes empty cursors to zero', () => {
    expect(syncCursor(undefined)).toBe('0');
    expect(syncCursor(null)).toBe('0');
    expect(syncCursor('')).toBe('0');
  });
});

function syncEvent(payload: Record<string, unknown>, operation = 'updated'): SyncEvent {
  return {
    ...baseEvent,
    operation,
    payload: payload as SyncEvent['payload']
  };
}

function syncQuery(overrides: Partial<Parameters<typeof mapSyncEventForScope>[1]> = {}) {
  return {
    scope: 'tasks' as const,
    teamId: 'all',
    cursor: '0',
    limit: 200,
    completedWindowDays: 5,
    ...overrides
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    key: 'CORE-1',
    title: 'Task',
    status: 'TODO',
    updatedAt: '2026-04-26T00:00:00.000Z',
    project: { team: { slug: 'ops' } },
    assignee: null,
    ...overrides
  };
}
