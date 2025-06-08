import { Controller, Get, Logger } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('vcf')
export class AppController {
  private readonly logger = new Logger(AppController.name)

  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHello(): string {
    return this.appService.getHello();
  }
}
