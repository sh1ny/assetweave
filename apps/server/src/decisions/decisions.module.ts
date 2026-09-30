import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MediaModule } from '../media/media.module.js';
import { DecisionsController } from './decisions.controller.js';
import { DecisionsService } from './decisions.service.js';

@Module({
  imports: [DatabaseModule, CatalogModule, MediaModule],
  controllers: [DecisionsController],
  providers: [DecisionsService],
  exports: [DecisionsService],
})
export class DecisionsModule {}
