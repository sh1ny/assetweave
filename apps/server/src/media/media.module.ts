import { Module } from '@nestjs/common';
import { CaptureModule } from '../capture/capture.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { PlaybackService } from './playback.service.js';

@Module({
  imports: [DatabaseModule, CaptureModule],
  controllers: [MediaController],
  providers: [MediaService, PlaybackService],
  exports: [MediaService, PlaybackService],
})
export class MediaModule {}
