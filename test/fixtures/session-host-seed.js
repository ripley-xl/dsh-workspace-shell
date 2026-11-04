import { randomUUID } from 'node:crypto';
export const inject = ['connection', 'sessionController', 'sessions', 'profileContext', 'sessionQuery'];
export function apply(ctx) {
  if (!ctx.profileContext.home.startsWith('/tmp/wsh-browser-')) throw new Error('Isolated test home required');
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-test/seed', methods: ['POST'], requestBody: 'buffered',
    async fetch() {
      const { sessionId } = await ctx.sessionController.create({ cwd: ctx.profileContext.home });
      const session = ctx.sessions.get(sessionId);
      session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Isolated cross-Host history fixture' }] }, { surfaceOp: 'append' });
      await ctx.sessions.flush(session);
      return Response.json({ sessionId });
    },
  }));
  for (const action of ['resume', 'inspect']) ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-test/' + action, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const { sessionId } = await request.json();
      if (action === 'resume') {
        const result = await ctx.sessionController.resolveAgent(sessionId);
        return Response.json({ acquired: !!result.agent, error: result.error?.code });
      }
      const snapshot = await ctx.sessionQuery.readSurface(sessionId);
      return Response.json({ userMessages: snapshot.events.filter((event) => event.type === 'user/message').length });
    },
  }));
}
