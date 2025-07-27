import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonService } from './common.service';

@Injectable()
export class VcfService {
    private readonly logger = new Logger(VcfService.name)
    private s3Dir: string;
    
    constructor(
        private readonly commonService: CommonService,
        private configService: ConfigService
    ) {
        this.s3Dir = this.configService.get<string>('AWS_DIR');
    }

    async run(analysis: any, vcfFile: string, vepOutput: string) {
        this.logger.log(`Running VCF analysis for analysis ID ${analysis.id}`);
        console.log(`VCF File: ${vcfFile}`);
        console.log(`VEP Output: ${vepOutput}`);
    }
}
