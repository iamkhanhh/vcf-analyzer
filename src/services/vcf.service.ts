import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisModel } from 'src/models/analysis.model';
import { CommonService } from './common.service';
import { VCF_NORMALIZED_FILE } from 'src/constants';

@Injectable()
export class VcfService {
    private readonly logger = new Logger(VcfService.name)
    private s3Dir: string;
    private fastaFile: string;
    
    constructor(
        private readonly commonService: CommonService,
        private configService: ConfigService
    ) {
        this.s3Dir = this.configService.get<string>('AWS_DIR');
        this.fastaFile = this.configService.get<string>('FASTA_FILE');
    }

    async getRowCount(vcfFilePath: string) {
        let command = `less ${vcfFilePath} | awk -F"\t" '{ if (index($0, "#") != 1) { split($5,a,","); col8 = $8; for (i in a){ $5=a[i]; $8=col8";VARINDEX="i; print }  }}' | wc -l`

        let count = await this.commonService.runCommand(command);

        return parseInt(count);
    }

    // async getRowCount(vcfFilePath: string): Promise<number> {
    //     const referencePath = '/path/to/reference.fa';

    //     const normalizeCommand = `cd ${this.s3Dir} && bcftools norm -m -any -f ${referencePath} ${vcfFilePath} -Oz -o ${VCF_NORMALIZED_FILE} && tabix -f -p vcf ${VCF_NORMALIZED_FILE}`;

    //     const countCommand = `bcftools view ${VCF_NORMALIZED_FILE} | grep -v '^#' | wc -l`;

    //     await this.commonService.runCommand(normalizeCommand);
    //     const count = await this.commonService.runCommand(countCommand);

    //     return parseInt(count.trim());
    // }
}
