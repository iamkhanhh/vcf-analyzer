import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonService } from './common.service';
import { AnalysisModel } from 'src/models/analysis.model';
import { AF_VCF_FILE, ANNO_CLINVAR_FILE, ANNO_FILE, ANNO_VEP_FILE, ORIGIN_VEP_FILE, VCF_HGMD, VCF_HGMD_CLINVAR, VCF_TRANSCRIPT_FILE, VEP_OUTPUT } from 'src/constants';

@Injectable()
export class VcfService {
    private readonly logger = new Logger(VcfService.name)
    
    private s3Dir: string;
    private analysisId;
    private analysis: AnalysisModel;
    private analysisFolder: string;
    private tmpFolderFormat: string;
    private vcfFile;
    private canonicalFile: string;
    private firstLine: boolean = true;
    private vcfHGMDFile;
    private vcfHgmdClinvarFile;
    private vcfTranscriptFile;
    private originAnnoFile;
    private originVepFile;
    private annoClinvarFile;
    private annoVepFile;
    private AfVcfFile;
    private annoFile;
    private headings;
    private annoArray = [];
    private prevLine: string;
    private annoStream: any;
    private vcfStream: any;
    private classifyStream: any;
    private checkAF: boolean = false;
    private lineIndex;
    
    constructor(
        private readonly commonService: CommonService,
        private configService: ConfigService
    ) {
        this.s3Dir = this.configService.get<string>('AWS_DIR');
    }

    async run(analysis: AnalysisModel, vcfFile: string, vepOutput: string) {
        this.logger.log(`Running VCF analysis for analysis ID ${analysis.id}`);
        console.log(`VCF File: ${vcfFile}`);
        console.log(`VEP Output: ${vepOutput}`);
        
        this.tmpFolderFormat = this.commonService.getTmpFolder(analysis);
        this.analysisFolder = this.commonService.getAnalysisFolder(analysis);
        console.log(`Temporary folder: ${this.tmpFolderFormat}`);
        
        this.analysisId = analysis.id;
        this.vcfFile = `${this.s3Dir}/${vcfFile}`;
        this.canonicalFile = `${vepOutput}`;
        
        this.vcfHGMDFile = `${this.tmpFolderFormat}/${VCF_HGMD}`;
        this.vcfHgmdClinvarFile = `${this.tmpFolderFormat}/${VCF_HGMD_CLINVAR}`;
        this.vcfTranscriptFile = `${this.tmpFolderFormat}/${VCF_TRANSCRIPT_FILE}`;
        this.originAnnoFile = this.vcfTranscriptFile;
        this.originVepFile = `${this.tmpFolderFormat}/${ORIGIN_VEP_FILE}`;
        this.annoFile = `${this.tmpFolderFormat}/${ANNO_FILE}`;
        this.annoClinvarFile = `${this.tmpFolderFormat}/${ANNO_CLINVAR_FILE}`;
        this.annoVepFile = `${this.tmpFolderFormat}/${ANNO_VEP_FILE}`;
        this.AfVcfFile = `${this.tmpFolderFormat}/${AF_VCF_FILE}`;

        await this.addTranscriptLength(vepOutput);

        await this.readVcf();

        await this.classifyVariant();

        // Upload files to s3
        await this.uploadFiles();
    }

    async addTranscriptLength (originAnnoFile: string) {
        this.logger.log(`Adding transcript length to VCF file: ${originAnnoFile}`);
        // let transcriptCommand = `/home/dev/genomics-annovar/command/anno.sh ${originAnnoFile} ${this.analysisId} ${this.vcfTranscriptFile}`
        // await this.commonService.runCommand(transcriptCommand);
    }

    async readVcf() {
        this.logger.log(`Reading VCF file: ${this.vcfFile}`);
    }

    async classifyVariant() {
        this.logger.log(`Classifying variants`);
    }

    async uploadFiles() {
        this.logger.log(`Uploading files`);
    }
}
