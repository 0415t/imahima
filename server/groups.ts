import { createHmac } from 'node:crypto';
import { Router } from 'express';

export type GroupOperation = 'create' | 'join' | 'list' | 'members' | 'leave' | 'invite';
export type GroupResult = { status: number; data: unknown };
export type GroupDependencies = {
  getUserId: (token: string) => Promise<{ userId: string | null; error: unknown | null }>;
  isMember: (userId: string, roomId: string) => Promise<boolean>;
  execute: (operation: GroupOperation, userId: string, args: Record<string, unknown>) => Promise<GroupResult>;
  consumeRate: (key: string, maximum: number) => Promise<boolean>;
  rateSecret: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function groupRouter(deps: GroupDependencies) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = req.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) { res.status(401).json({ error: 'Bearer token is required' }); return; }
    try {
      const auth = await deps.getUserId(token);
      if (auth.error || !auth.userId) { res.status(401).json({ error: 'Invalid or expired access token' }); return; }
      res.locals.userId = auth.userId;
      next();
    } catch { res.status(503).json({ error: 'Authentication unavailable' }); }
  });

  const route = (method: 'get' | 'post' | 'delete', path: string, operation: GroupOperation) => {
    router[method](path, async (req, res) => {
      try {
        const userId = res.locals.userId as string;
        const roomId = req.params.id;
        if (roomId && (typeof roomId !== 'string' || !uuid.test(roomId))) {
          res.status(400).json({ error: 'Invalid group ID' }); return;
        }
        if (roomId && !await deps.isMember(userId, roomId)) {
          res.status(404).json({ error: 'Group not found' }); return;
        }
        if (operation === 'join' || operation === 'create') {
          // No trust proxy override: do not trust a caller-supplied X-Forwarded-For.
          const hash = (value: string) => createHmac('sha256', deps.rateSecret).update(value).digest('hex');
          const userAllowed = await deps.consumeRate(hash(`${operation}:user:${userId}`), 5);
          const ipAllowed = await deps.consumeRate(hash(`${operation}:ip:${req.ip ?? 'unknown'}`), 30);
          if (!userAllowed || !ipAllowed) {
            res.set('Retry-After', '60').status(429).json({ error: 'Too many attempts' }); return;
          }
        }
        const args: Record<string, unknown> = { room_id: roomId };
        if (operation === 'create') {
          const name = req.body?.name;
          if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 100) {
            res.status(400).json({ error: 'Name must contain 1 to 100 characters' }); return;
          }
          args.name = name.trim();
        }
        if (operation === 'join') {
          const code = req.body?.invite_code;
          // Preserve case for existing six-character codes.
          if (typeof code !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(code.trim())) {
            res.status(400).json({ error: 'Invalid invitation code' }); return;
          }
          args.invite_code = code.trim();
        }
        if (operation === 'list' || operation === 'members') {
          const limit = req.query.limit ?? '50';
          const offset = req.query.offset ?? '0';
          if (typeof limit !== 'string' || !/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
              typeof offset !== 'string' || !/^[0-9]+$/.test(offset) || !Number.isSafeInteger(Number(offset)) || Number(offset) > 100000) {
            res.status(400).json({ error: 'Invalid pagination' }); return;
          }
          args.limit = Number(limit); args.offset = Number(offset);
        }
        const result = await deps.execute(operation, userId, args);
        if (result.status === 204) res.status(204).end();
        else res.status(result.status).json(result.data);
      } catch {
        // Never log request bodies, invitation codes, tokens, or database error details.
        res.status(503).json({ error: 'Group service unavailable' });
      }
    });
  };
  route('post', '/', 'create');
  route('post', '/join', 'join');
  route('get', '/', 'list');
  route('get', '/:id/members', 'members');
  route('get', '/:id/invite-code', 'invite');
  route('delete', '/:id/members/me', 'leave');
  return router;
}
