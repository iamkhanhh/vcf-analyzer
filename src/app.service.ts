import { Injectable, Logger } from '@nestjs/common';
import { AnnovarService, CommunicationService, GlobalService, VcfService } from './services';
import { CommonService } from './services/common.service';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalysisModel, AnalysisStatus } from './models/analysis.model';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name)

  constructor(
    private readonly annovarService: AnnovarService,
    private readonly commonService: CommonService,
    private readonly configService: ConfigService,
    private readonly globalService: GlobalService,
    private readonly communicationService: CommunicationService,
    private readonly vcfService: VcfService
  ) { }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async vcf_analyzer() {
    let pendingAnalysis;
    try {
      if (this.globalService.isAnalyzing) {
        return;
      }

      pendingAnalysis = await this.communicationService.getPendingAnalysis();
      if (!pendingAnalysis) {
        this.logger.log('No pending analysis found');
        this.globalService.isAnalyzing = false;
        return;
      }

      this.globalService.isAnalyzing = true;
      this.logger.log('Starting VCF analysis');

      await this.communicationService.updateAnalysisStatus(pendingAnalysis.id, AnalysisStatus.ANALYZING);

      await this.analyze(pendingAnalysis);

      await this.communicationService.updateAnalysisStatus(pendingAnalysis.id, AnalysisStatus.ANALYZED);

      return this.globalService.isAnalyzing = false;

    } catch (error) {
      this.globalService.isAnalyzing = false;
      this.logger.error('Error in vcf_analyzer', error);
      await this.communicationService.updateAnalysisStatus(pendingAnalysis.id, AnalysisStatus.ERROR);
    }
  }

  async analyze(analysis: AnalysisModel) {
    this.logger.log(`Analyzing VCF for analysis ID: ${analysis.id}`);
    try {
      console.log(analysis);
      
    } catch (error) {
      this.logger.error(`Error analyzing VCF for analysis ID ${analysis.id}`, error);
      throw error;
    }
  }

  getHello(): string {
    return 'Good!';
  }
}
