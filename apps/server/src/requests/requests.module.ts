import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { LineageService } from '../lineage/lineage.service.js';
import { ProvenanceService } from '../provenance/provenance.service.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [RequestsController],
  providers: [RequestsService, ProvenanceService, LineageService],
  exports: [RequestsService, ProvenanceService, LineageService],
})
export class RequestsModule {}
