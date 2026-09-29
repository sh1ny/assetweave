import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
export const WEB_DIST = Symbol('WEB_DIST');

@Controller()
export class ShellController {
  constructor(@Inject(WEB_DIST) private readonly webDist: string) {}

  @Get()
  home(@Res() reply: FastifyReply): FastifyReply {
    return reply.sendFile('index.html', this.webDist);
  }

  @Get('pair')
  pair(@Res() reply: FastifyReply): FastifyReply {
    return reply.sendFile('index.html', this.webDist);
  }

  @Get('connection')
  connection(@Res() reply: FastifyReply): FastifyReply {
    return reply.sendFile('index.html', this.webDist);
  }
}
