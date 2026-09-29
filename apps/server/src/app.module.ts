import { DynamicModule, Module } from '@nestjs/common';
import { RuntimeModule } from './runtime/runtime.module.js';
import { ProfileService } from './runtime/profile.service.js';

@Module({})
export class AppModule {
  static register(profile: ProfileService, webDist: string): DynamicModule {
    return {
      module: AppModule,
      imports: [RuntimeModule.register(profile, webDist)],
    };
  }
}
