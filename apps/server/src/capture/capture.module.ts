import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { CaptureController } from './capture.controller.js';
import { CaptureService } from './capture.service.js';
import { ContentStore } from './content-store.js';

@Module({
  imports: [DatabaseModule, CatalogModule, RequestsModule],
  controllers: [CaptureController],
  providers: [CaptureService, ContentStore],
  exports: [CaptureService, ContentStore],
})
export class CaptureModule {}
