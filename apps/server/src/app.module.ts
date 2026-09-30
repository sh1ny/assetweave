import { DynamicModule, Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { CaptureModule } from './capture/capture.module.js';
import { DecisionsModule } from './decisions/decisions.module.js';
import { MediaModule } from './media/media.module.js';
import { QueriesModule } from './queries/queries.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { ProfileService } from './runtime/profile.service.js';

@Module({})
export class AppModule {
  static register(profile: ProfileService, webDist: string): DynamicModule {
    return {
      module: AppModule,
      imports: [RuntimeModule.register(profile, webDist), CatalogModule, RequestsModule, CaptureModule, MediaModule, DecisionsModule, QueriesModule],
    };
  }
}
