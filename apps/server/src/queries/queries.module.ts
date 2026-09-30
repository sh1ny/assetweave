import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ContextService } from './context.service.js';
import { QueriesController } from './queries.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [QueriesController],
  providers: [SearchService, ContextService],
  exports: [SearchService, ContextService],
})
export class QueriesModule {}
