import { Body, Controller, Delete, Get, HttpException, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LocalAccessService } from './local-access.service.js';

@Controller('api')
export class SessionController {
  constructor(private readonly access: LocalAccessService) {}

  @Post('pair')
  pair(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply): { authenticated: true } {
    const capability = body && typeof body === 'object' && 'capability' in body && body.capability;
    if (typeof capability !== 'string' || capability.length > 512) {
      throw new HttpException({ code: 'INVALID_REQUEST', message: 'Enter the one-time code from the private launcher.' }, 400);
    }
    const paired = this.access.pair(capability);
    if (!paired) throw new HttpException({ code: 'UNAUTHORIZED', message: 'Pairing code was invalid, used, or expired. Request a new code in the terminal.' }, 401);
    reply.header('Set-Cookie', paired.cookie);
    return { authenticated: true };
  }

  @Get('session')
  session(@Req() request: FastifyRequest): { authenticated: true; csrfToken: string } {
    if (request.localAuthorization?.kind !== 'browser') {
      throw new HttpException({ code: 'UNAUTHORIZED', message: 'A paired browser session is required.' }, 401);
    }
    return { authenticated: true, csrfToken: this.access.session(request).csrfToken };
  }

  @Get('connection')
  connection(): { origin: string; profile: string } {
    return { origin: this.access.getOrigin(), profile: this.access.profile.path };
  }

  @Delete('session')
  disconnect(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): { authenticated: false } {
    if (request.localAuthorization?.kind !== 'browser') {
      throw new HttpException({ code: 'UNAUTHORIZED', message: 'A paired browser session is required.' }, 401);
    }
    this.access.endSession(request);
    reply.header('Set-Cookie', 'assetweave_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { authenticated: false };
  }
}

@Controller('__local')
export class LauncherController {
  constructor(private readonly access: LocalAccessService) {}

  @Post('pair-capability')
  issueCapability(): { capability: string; expiresAt: number } {
    return this.access.issueCapability();
  }
}
