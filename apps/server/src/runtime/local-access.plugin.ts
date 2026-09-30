import type { FastifyInstance } from 'fastify';
import { LocalAccessService } from './local-access.service.js';

export function installLocalAccess(fastify: FastifyInstance, access: LocalAccessService): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    access.authorize(request, reply);
    if (!reply.sent) done();
  });
}
