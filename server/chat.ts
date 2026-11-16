import { Router } from 'express';
import { authenticate } from './auth';
import { requestStep } from './timeouts';
import type { GroupDependencies, GroupResult } from './groups';

export type ChatOperation = 'send' | 'history' | 'delete' | 'events';
export type ChatDependencies = Pick<GroupDependencies, 'getUserId' | 'isMember'> & {
  execute: (operation: ChatOperation, actor: string, args: Record<string, unknown>) => Promise<GroupResult>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sequence = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 19 && BigInt(v) <= 9223372036854775807n;
export const isChatPath = (path: string) => /^\/groups\/[^/]+\/(?:messages|message-events)(?:\/|$)/.test(path);

function decodeCursor(value: unknown, room: string, events: boolean): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('cursor');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw Error('cursor');
  const cursor: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const keys = events ? ['v', 'room_id', 'direction', 'after_seq', 'through_seq'] : ['v', 'room_id', 'direction', 'before_seq'];
  if (!object(cursor) || Object.keys(cursor).length !== keys.length || keys.some(k => !(k in cursor)) ||
    cursor.v !== 1 || cursor.room_id !== room || cursor.direction !== (events ? 'after' : 'before')) throw Error('cursor');
  if (events ? !sequence(cursor.after_seq) || !sequence(cursor.through_seq) || BigInt(cursor.after_seq) > BigInt(cursor.through_seq)
    : !sequence(cursor.before_seq) || cursor.before_seq === '0') throw Error('cursor');
  return cursor;
}

export function chatRouter(deps: ChatDependencies) {
  const router = Router();
  const route = (method: 'get' | 'post' | 'delete', path: string, operation: ChatOperation) => {
    router[method](path, async (req, res) => {
      const fail = (status: number, code: string, error: string) => { if (!res.headersSent && !res.destroyed) res.status(status).json({ error, code }); };
      res.set('Cache-Control', 'no-store');
      const token = req.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token) { fail(401, 'UNAUTHENTICATED', 'Bearer token is required'); return; }
      try {
        const auth = await authenticate(deps.getUserId, token);
        if (auth.status !== 200) {
          fail(auth.status, auth.status === 401 ? 'UNAUTHENTICATED' : 'CHAT_UNAVAILABLE',
            auth.status === 401 ? 'Invalid or expired access token' : 'Chat service unavailable');
          return;
        }
        const room = req.params.roomId;
        const message = req.params.messageId;
        if (typeof room !== 'string' || !uuid.test(room) || (operation === 'delete' && (typeof message !== 'string' || !uuid.test(message)))) {
          fail(400, 'INVALID_INPUT', 'Invalid ID'); return;
        }
        const roomId = room.toLowerCase();
        const args: Record<string, unknown> = { p_room_id: roomId };
        const reads = operation === 'history' || operation === 'events';
        const allowed = reads ? operation === 'events' ? ['limit', 'cursor', 'after_event_seq'] : ['limit', 'cursor'] : [];
        if (Object.keys(req.query).some(k => !allowed.includes(k)) || (!reads && operation === 'delete' && req.body !== undefined) || (reads && req.body !== undefined)) {
          fail(400, 'INVALID_INPUT', 'Unexpected parameters or body'); return;
        }
        if (operation === 'send') {
          if (!req.is('application/json') || !object(req.body) || Object.keys(req.body).some(k => !['body', 'client_message_id'].includes(k))) {
            fail(400, 'INVALID_INPUT', 'Expected body and client_message_id'); return;
          }
          const body = typeof req.body.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : null;
          // Reject ill-formed UTF-16 and NUL before PostgreSQL text conversion.
          if (body === null || body.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body) ||
            [...body].length < 1 || [...body].length > 500 || /^\p{White_Space}*$/u.test(body) ||
            typeof req.body.client_message_id !== 'string' || !uuid.test(req.body.client_message_id)) {
            fail(400, 'INVALID_INPUT', 'Invalid message body or client_message_id'); return;
          }
          args.p_body = body; args.p_client_message_id = req.body.client_message_id;
        } else if (operation === 'delete') args.p_message_id = message;
        else {
          const limit = req.query.limit ?? '50';
          if (typeof limit !== 'string' || !/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100) {
            fail(400, 'INVALID_INPUT', 'Invalid limit'); return;
          }
          args.p_limit = Number(limit);
          if (req.query.cursor !== undefined) {
            if (req.query.after_event_seq !== undefined) { fail(400, 'INVALID_CURSOR', 'Cursor and after_event_seq are mutually exclusive'); return; }
            try { args.p_cursor = decodeCursor(req.query.cursor, roomId, operation === 'events'); }
            catch { fail(400, 'INVALID_CURSOR', 'Invalid cursor'); return; }
          }
          if (operation === 'events') {
            const after = req.query.after_event_seq ?? '0';
            if (!sequence(after)) { fail(400, 'INVALID_CURSOR', 'Invalid event position'); return; }
            args.p_after_event_seq = after;
          }
        }
        if (!await requestStep(() => deps.isMember(auth.userId, roomId))) { fail(404, 'GROUP_NOT_FOUND', 'Group not found'); return; }
        const result = await requestStep(() => deps.execute(operation, auth.userId, args));
        if (![200, 201, 400, 401, 403, 404, 409, 429, 503].includes(result.status) || !object(result.data)) throw Error('Invalid RPC result');
        const data = { ...result.data };
        if (result.status === 429) {
          if (!Number.isSafeInteger(data.retry_after_seconds) || Number(data.retry_after_seconds) < 1) throw Error('Invalid retry delay');
          res.set('Retry-After', String(data.retry_after_seconds));
        }
        if (data.next_cursor !== undefined && data.next_cursor !== null) {
          if (!object(data.next_cursor)) throw Error('Invalid RPC cursor');
          data.next_cursor = Buffer.from(JSON.stringify(data.next_cursor)).toString('base64url');
        }
        res.status(result.status).json(data);
      } catch { fail(503, 'CHAT_UNAVAILABLE', 'Chat service unavailable'); }
    });
  };
  route('post', '/:roomId/messages', 'send');
  route('get', '/:roomId/messages', 'history');
  route('delete', '/:roomId/messages/:messageId', 'delete');
  route('get', '/:roomId/message-events', 'events');
  return router;
}
