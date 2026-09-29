import { DynamicModule, Global, Module } from '@nestjs/common';
import { ProfileService } from './profile.service.js';
import { LocalAccessService } from './local-access.service.js';
import { LauncherController, SessionController } from './session.controller.js';
import { ShellController, WEB_DIST } from './shell.controller.js';

@Global()
@Module({})
export class RuntimeModule {
  static register(profile: ProfileService, webDist: string): DynamicModule {
    return {
      module: RuntimeModule,
      controllers: [SessionController, LauncherController, ShellController],
      providers: [
        { provide: ProfileService, useValue: profile },
        LocalAccessService,
        { provide: WEB_DIST, useValue: webDist },
      ],
      exports: [ProfileService, LocalAccessService],
    };
  }
}
