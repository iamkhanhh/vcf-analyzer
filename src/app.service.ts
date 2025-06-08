import { Injectable, Logger } from '@nestjs/common';
import { AnnovarService, VcfService } from './services';
import { CommonService } from './services/common.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name)

  constructor(
      private readonly annovarService: AnnovarService,
      private readonly commonService: CommonService,
      private readonly configService: ConfigService,
      private readonly vcfService: VcfService
  ) {}

  

  getHello(): string {
    return 'Good!';
  }
}
