import { Injectable, Logger } from '@nestjs/common';
import { AnnovarService, CommunicationService, GlobalService, VcfService } from './services';
import { CommonService } from './services/common.service';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalysisModel, AnalysisStatus } from './models/analysis.model';
import * as fs from 'fs'
import { INTERSECT_BED_CMD, RESULT_ANNO_FILE, VCF_APPLIED_BED, VCF_BGZIP_CMD, VCF_FILE, VCF_MODIFIED_FILE, VCF_ORIGINAL_FILE, VCF_ORIGINAL_ZIP_FILE, VCF_SORT_CMD, VCF_TABIX_CMD, VCF_ZIP_FILE, VEP_OUTPUT } from './constants';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name)

  private analysisFolder: string;
  private defaultBedFile: string;
  private wesHg19BedFile: string;
  private wesHg38BedFile: string;
  private s3Dir: string;
  private vcfModified: string;
  private vcfOriginal: string;
  private vcfBed: string;
  private vcfFile: string;
  private vepOutput: string;
  private dataFolder: string;
  private pharmaGkbFile: string;
  private analysis: AnalysisModel;
  private isGZ: boolean = false;
  private CWD = process.cwd();

  constructor(
    private readonly annovarService: AnnovarService,
    private readonly commonService: CommonService,
    private readonly configService: ConfigService,
    private readonly globalService: GlobalService,
    private readonly communicationService: CommunicationService,
    private readonly vcfService: VcfService
  ) {
    this.defaultBedFile = this.configService.get<string>('DEFAULT_BED');
    this.wesHg19BedFile = this.configService.get<string>('WES_HG19_BED');
    this.wesHg38BedFile = this.configService.get<string>('WES_HG38_BED');
    this.s3Dir = this.configService.get<string>('AWS_DIR');
    this.dataFolder = this.commonService.getDataFolder();
    this.pharmaGkbFile = "PharmaGKB.tsv";
  }

  // @Cron(CronExpression.EVERY_30_SECONDS)
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
      console.log(pendingAnalysis);

      await this.communicationService.updateAnalysisStatus(pendingAnalysis.id, AnalysisStatus.ANALYZING);

      await this.analyze(pendingAnalysis);

      await this.communicationService.updateAnalysisStatus(pendingAnalysis.id, AnalysisStatus.VEP_ANALYZED);

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
      this.analysisFolder = this.commonService.getAnalysisFolder(analysis);
      this.analysis = analysis;
      this.vcfBed = `${this.analysisFolder}/${VCF_APPLIED_BED}`;
      this.vcfFile = `${this.analysisFolder}/${VCF_FILE}`
      this.vcfModified = `${this.analysisFolder}/${VCF_MODIFIED_FILE}`;
      this.vepOutput = `${this.CWD}/tmp/analysis_${analysis.id}/${VEP_OUTPUT}`;

      await this.preprocess();

      await this.fomatVcfFile();

      await this.applyBedFile();

      await this.prepareFile();

      await this.annovarService.runVEP(this.vcfFile, this.vepOutput, this.analysis.assembly);

      await this.annovarService.matchHGNC(this.vepOutput);

      // Run VCF analysis
      await this.vcfService.run(analysis, this.vcfFile, this.vepOutput);

      // PGx report
      await this.addPGxReport();

      this.logger.log('Done Analysis')
    } catch (error) {
      this.logger.error(`Error analyzing VCF for analysis ID ${this.analysis.id}`, error);
      throw error;
    }
  }

  async preprocess() {
    this.logger.log('Preprocessing VCF file');
    let copyOriginalFile = '';
    this.isGZ = this.analysis.upload.file_path.indexOf('vcf.gz') != -1 ? true : false;
    this.vcfOriginal = `${this.analysisFolder}/${this.isGZ ? VCF_ORIGINAL_ZIP_FILE : VCF_ORIGINAL_FILE}`;

    if (!fs.existsSync(`${this.s3Dir}/${this.analysis.upload.file_path}`)) {
      throw new Error('Original file not found!');
    }

    if (!fs.existsSync(`${this.s3Dir}/${this.vcfOriginal}`)) {
      this.logger.log('Copy original file!');
      copyOriginalFile = `&& cp ${this.analysis.upload.file_path} ${this.vcfOriginal}`;
    }

    let command = `cd ${this.s3Dir} ${copyOriginalFile}`
    return await this.commonService.runCommand(command);
  }

  async fomatVcfFile() {
    this.logger.log('Format VCF file');

    let zipFileCommand = 'ls';

    if (this.isGZ) {
      zipFileCommand = `bgzip -c ${this.vcfFile} > ${this.vcfFile}.gz`;
    }

    let commands = [
      `cd ${this.s3Dir}`,
      `less ${this.vcfOriginal} | awk 'BEGIN{OFS="\t"} { if(index($0, "#") == 1) {print $0;} else { if( $9== "GT:GQ:AD:DP:VF:NL:SB:NC:US") {} else { split($1,a,"chr"); if(a[2] != NULL ) { $1 = a[2];}; print $0;} } }' > ${this.vcfFile}`,
      zipFileCommand
    ]

    let command = commands.join(' && ');

    await this.commonService.runCommand(command);
  }

  async applyBedFile() {
    this.logger.log('Applying BED file');

    let count = await this.annovarService.getRowCount(`${this.s3Dir}/${this.vcfFile}`);

    console.log(`Row count in VCF file: ${count}`);

    let bedFile = this.defaultBedFile;

    if (this.analysis.assembly == 'hg19' && this.analysis.sequencing_type == 'WES') {
      bedFile = this.wesHg19BedFile;
    } else if (this.analysis.assembly == 'hg38' && this.analysis.sequencing_type == 'WES') {
      bedFile = this.wesHg38BedFile;
    }

    let options = [
      `-b ${bedFile}`,
      `-a ${this.isGZ ? `${this.vcfFile}.gz` : this.vcfFile}`
    ];

    let zipFileCommand = 'ls';

    if (this.isGZ) {
      zipFileCommand = `${VCF_BGZIP_CMD} -f ${this.vcfBed} && ${VCF_TABIX_CMD} -f ${this.vcfBed}.gz`;
    }

    let commands = [
      `cd ${this.s3Dir}`,
      `${INTERSECT_BED_CMD} ${options.join(' ')} | grep -v "0/0" > ${this.vcfFile}.body`,
      `less ${this.vcfFile} | awk '{if (index($0, "#") == 1) print $0}' > ${this.vcfFile}.header`,
      `cat ${this.vcfFile}.header ${this.vcfFile}.body > ${this.vcfBed}`,
      `rm -rf ${this.vcfFile}.header ${this.vcfFile}.body`,
      zipFileCommand
    ];

    let command = commands.filter(cmd => cmd).join(' && ');

    await this.commonService.runCommand(command);

    // Compressed bed & get tabix
    // commands = [
    //   `cd ${this.s3Dir}`,
    //   `${VCF_BGZIP_CMD} -f ${this.vcfBed}`,
    //   `${VCF_TABIX_CMD} -f ${this.vcfBed}.gz`
    // ];

    // command = commands.join(' && ');

    // await this.commonService.runCommand(command);
  }

  async prepareFile() {
    this.logger.log('Preparing file for analysis');
    // Implement file preparation logic here
    if (this.isGZ) {
      await this.prepareZipFile()
    } else {
      await this.prepareNormalFile()
    }
  }

  async prepareZipFile() {
    this.logger.log('Preparing zipped VCF file');

    let sortCmd = `zless ${this.vcfBed}.gz | awk '$1 ~ /^#/ {print $0;next} {print $0 | "sort -k1,1V -k2,2n"}' > ${this.vcfFile}`;
    let bgzipCmd = `${VCF_BGZIP_CMD} -c ${this.vcfFile} > ${this.vcfFile}.gz`;
    let tabixCmd = `${VCF_TABIX_CMD} -f ${this.vcfFile}.gz`;

    let commands = [
      `cd ${this.s3Dir}`,
      sortCmd,
      bgzipCmd,
      tabixCmd
    ];

    let command = commands.join(' && ');

    await this.commonService.runCommand(command);

    await this.annovarService.validateVcf(this.vcfFile);

    await this.annovarService.cleanVcf(this.vcfFile, this.vcfModified);
  }

  async prepareNormalFile() {
    this.logger.log('Preparing normal VCF file');

    let sortCmd = `cd ${this.s3Dir} && less ${this.vcfBed} | awk '$1 ~ /^#/ {print $0;next} {print $0 | "sort -k1,1V -k2,2n"}' > ${this.vcfFile}`;

    await this.commonService.runCommand(sortCmd);

    await this.annovarService.validateVcf(this.vcfFile);

    await this.annovarService.cleanVcf(this.vcfFile, this.vcfModified);

    let bgzipCmd = `${VCF_BGZIP_CMD} -c ${this.vcfFile} > ${this.vcfFile}.gz`;
    let tabixCmd = `${VCF_TABIX_CMD} -f ${this.vcfFile}.gz`;

    let commands = [
      `cd ${this.s3Dir}`,
      bgzipCmd,
      tabixCmd
    ];

    let command = commands.join(' && ');

    await this.commonService.runCommand(command);
  }

  async addPGxReport() {
    this.logger.log('Adding PGx report to analysis result');

    const pgxSource = `${this.dataFolder}/${this.pharmaGkbFile}`

    const annoFile = `${this.s3Dir}/${this.analysisFolder}/${RESULT_ANNO_FILE}`;

    let command = `awk -F"\t" 'FNR==NR{a[$1]=1; next}{ if ($1 == "analysisId") { print $0"\tPGx"; } else { PGx = "."; if (a[$9] == 1) { PGx = 1; } print $0"\t"PGx; } }' ${pgxSource} ${annoFile} > ${annoFile}.pgx && mv ${annoFile}.pgx ${annoFile} `;

    await this.commonService.runCommand(command);
  }

  async triggerAnalysis(analysis: AnalysisModel): Promise<void> {
    if (this.globalService.isAnalyzing) {
      this.logger.warn(`Trigger ignored: analysis ${analysis.id} submitted while another is running`);
      return;
    }
    this.globalService.isAnalyzing = true;
    this.logger.log(`Manual trigger for analysis ID: ${analysis.id}`);
    try {
      await this.analyze(analysis);
    } catch (error) {
      this.logger.error(`triggerAnalysis failed for ID ${analysis.id}`, error);
    } finally {
      this.globalService.isAnalyzing = false;
    }
  }

  getHello(): string {
    return 'Good!';
  }
}
