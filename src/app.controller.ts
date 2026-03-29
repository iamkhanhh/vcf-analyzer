import { Body, Controller, Get, HttpCode, Logger, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { AnalysisModel } from './models/analysis.model';

@Controller('vcf')
export class AppController {
  private readonly logger = new Logger(AppController.name)

  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('trigger')
  @HttpCode(202)
  triggerAnalysis(@Body() analysis: AnalysisModel): { message: string; id: number } {
    this.appService.triggerAnalysis(analysis);
    return { message: 'Analysis started', id: analysis.id };
  }
}
