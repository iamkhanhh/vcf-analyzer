import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonService } from './common.service';
import { AnalysisModel } from 'src/models/analysis.model';
import * as fs from 'fs';
import * as es from 'event-stream';
import { AF_VCF_FILE, ANNO_CLINVAR_FILE, ANNO_FILE, ANNO_VEP_FILE, ORIGIN_VEP_FILE, RESULT_ANNO_FILE, RESULT_CANONICAL_FILE, VCF_HGMD, VCF_HGMD_CLINVAR, VCF_TRANSCRIPT_FILE, VEP_OUTPUT } from 'src/constants';
import { CalculateService } from './calculate.service';
import { exec } from 'child_process';

@Injectable()
export class VcfService {
    private readonly logger = new Logger(VcfService.name)

    private s3Dir: string;
    private analysisId;
    private analysis: AnalysisModel;
    private analysisFolder: string;
    private tmpFolderFormat: string;
    private commandFolder: string;
    private dataFolder: string;
    private vcfFile;
    private canonicalFile: string;
    private vcfHGMDFile;
    private vcfHgmdClinvarFile;
    private vcfTranscriptFile;
    private originAnnoFile;
    // private originVepFile;
    // private annoClinvarFile;
    private annoVepFile;
    private AfVcfFile;
    private annoFile;
    private headings;
    private annoArray = [];
    private annoStream: any;
    private vcfStream: any;
    private classifyStream: any;
    private checkAF: boolean = false;
    private lineIndex;

    private _clinvarDir: string
    private _cosmic: string
    private _clinvarBTG: string
    private _hgmdPath: string

    private getHeadingIndex(...names: string[]): number {
        for (const name of names) {
            const index = this.annoStream.headings.indexOf(name);
            if (index !== -1) {
                return index;
            }
        }

        return -1;
    }

    private getLineValue(lineData: string[], ...names: string[]): string {
        const index = this.getHeadingIndex(...names);

        if (index === -1) {
            return '.';
        }

        const value = lineData[index];
        return value == undefined || value === '' ? '.' : value;
    }

    private getExtraValue(extraData: string[], ...names: string[]): string {
        const value = this.getLineValue(extraData, ...names);
        return this.calculateService.formatData(value);
    }

    constructor(
        private readonly commonService: CommonService,
        private configService: ConfigService,
        private readonly calculateService: CalculateService
    ) {
        this.s3Dir = this.configService.get<string>('AWS_DIR');
        this.commandFolder = this.commonService.getCommandFolder();
        this.dataFolder = this.commonService.getDataFolder();
        this._clinvarDir = this.configService.get<string>('CLINVAR_DIR');
        this._clinvarBTG = this.configService.get<string>('CLINVAR_BTG');
        this._cosmic = this.configService.get<string>('COSMIC');
        this._hgmdPath = this.configService.get<string>('HGMD_PATH');

    }

    async run(analysis: AnalysisModel, vcfFile: string, vepOutput: string) {
        this.logger.log(`Running VCF analysis for analysis ID ${analysis.id}`);
        console.log(`VCF File: ${vcfFile}`);
        console.log(`VEP Output: ${vepOutput}`);

        this.tmpFolderFormat = this.commonService.getTmpFolder(analysis);
        this.analysisFolder = this.commonService.getAnalysisFolder(analysis);

        this.analysisId = analysis.id;
        this.vcfFile = `${this.s3Dir}/${vcfFile}`;
        this.canonicalFile = `${vepOutput}`;

        this.vcfHGMDFile = `${this.tmpFolderFormat}/${VCF_HGMD}`;
        this.vcfHgmdClinvarFile = `${this.tmpFolderFormat}/${VCF_HGMD_CLINVAR}`;
        this.vcfTranscriptFile = `${this.tmpFolderFormat}/${VCF_TRANSCRIPT_FILE}`;
        this.originAnnoFile = this.vcfTranscriptFile;
        this.annoFile = `${this.tmpFolderFormat}/${ANNO_FILE}`;
        // this.annoClinvarFile = `${this.tmpFolderFormat}/${ANNO_CLINVAR_FILE}`;
        this.annoVepFile = `${this.tmpFolderFormat}/${ANNO_VEP_FILE}`;
        this.AfVcfFile = `${this.tmpFolderFormat}/${AF_VCF_FILE}`;

        await this.addTranscriptLength(vepOutput);

        await this.readVcf();

        await this.classifyVariant();

        // Upload files to s3
        await this.uploadFiles();
    }

    async addTranscriptLength(originAnnoFile: string) {
        this.logger.log(`Adding transcript length to VCF file: ${originAnnoFile}`);
        let transcriptCommand = `${this.commandFolder}/add_transcript_length.sh ${originAnnoFile} ${this.dataFolder} ${this.tmpFolderFormat} ${this.vcfTranscriptFile}`
        await this.commonService.runCommand(transcriptCommand);
    }

    async readVcf() {
        this.logger.log(`Reading VCF file: ${this.vcfFile}`);

        return new Promise((resolve, reject) => {
            this.vcfStream = fs.createReadStream(this.vcfFile)
                .pipe(es.split())
                .pipe(es.mapSync((line) => {
                    this.vcfStream.pause();

                    if (this.lineIndex != null) {
                        if (!line) {
                            this.vcfStream.resume();
                            return;
                        }

                        this.lineIndex++;

                        this.vcfStream.extraData = this.analyzeLine(line);

                        this.writeAfVcf(line, this.vcfStream.extraData);

                        this.resumeAnnoStream();
                    } else {
                        let lineData = line.split('\t')
                        let lineString = line;
                        if (line.search('#CHROM') == 0) {
                            this.lineIndex = 0;
                            this.headings = line.split('\t');
                            console.log('headings: ', this.headings);
                            lineString = lineData.join('\t');
                        }
                        fs.appendFileSync(this.AfVcfFile, lineString + '\n')

                        this.vcfStream.extraData = []
                        this.vcfStream.resume()
                    }
                }))
                .on('error', (error) => {
                    this.vcfStream.hasError = true
                    this.logger.error('Read vcf error')
                    this.logger.error(error);
                    this.vcfStream.destroy();
                })
                .on('close', () => {
                    this.logger.log('Close readVCF')
                    if (!this.annoStream.ended) {
                        this.annoStream.ended = true
                        this.annoStream.destroy()
                    }

                    if (this.vcfStream.hasError) {
                        return reject(false);
                    } else {
                        // IF AF only 1.00 or 0.500
                        let tabixComand = '';
                        if (this.checkAF == false) {
                            let compressedFile = this.AfVcfFile + '.gz';
                            let tabixFile = this.AfVcfFile + '.gz.tbi';
                            let compressedFileDist = this.vcfFile + '.gz';
                            let tabixFileDist = this.vcfFile + '.gz.tbi';

                            tabixComand = `{ grep "^#" ${this.AfVcfFile}; grep -v "^#" ${this.AfVcfFile} | sort -k1,1 -k2,2n; } > ${this.AfVcfFile}_sorted && mv -f ${this.AfVcfFile}_sorted ${this.AfVcfFile} && bgzip -f ${this.AfVcfFile} && tabix -f ${compressedFile} && rm -rf ${compressedFileDist} ${tabixFileDist} && mv -f ${compressedFile} ${compressedFileDist} && mv -f ${tabixFile} ${tabixFileDist} && `
                        }

                        let clearRefAlt = `awk -F"\t" 'BEGIN{OFS="\t"}{ref = $7;alt = $8; chrom = $5; pos = $6; gene = $16; if(index($0, "analysisId") == 1) { print $0;} else if (length(ref) == 1 || length(alt) == 1) { $83=chrom"_"pos"_"ref"_"alt"_"gene; print $0;} else if (substr(ref,length(ref),1) != substr(alt,length(alt),1)) {$83=chrom"_"pos"_"ref"_"alt"_"gene; print $0;} else {while (length(ref) != 1 && length(alt) != 1 && substr(ref,length(ref),1) == substr(alt,length(alt),1)) {ref = substr(ref, 1, length(ref)-1);alt = substr(alt, 1, length(alt)-1);}$83=chrom"_"pos"_"ref"_"alt"_"gene; print $0;}}' ${this.annoFile} >  ${this.annoFile}_temp && mv -f ${this.annoFile}_temp ${this.annoFile} && `

                        // Add ClinVar
                        let clinVarCommand = `awk -F"\t" 'FNR==NR{a[$1"_"$2"_"$3"_"$4"_"$7]=$5"\t"$6"\t"$8"\t"$9"\t"$10"\t"$11; b[$1"_"$2"_"$3"_"$4"_"$7]=$12; next}{ curation = (length(b[$83]) == 0) ? "." : b[$83]; if(index($0, "analysisId") == 1) {print $0"\tCLNACC\tCLNSIG_BTG\treview_status\tlast_evaluated\tgold_stars\tconsensus_score\tcuration"} else if (length(a[$83]) == 0) { print $0"\t.\t.\t.\t.\t.\t.\t"curation } else { print $0"\t"a[$83]"\t"curation }}' ${this._clinvarDir} ${this.annoFile}  > ${this.vcfHGMDFile} `

                        // Add Nan ClinVar
                        let BTGConcensusCommand = `&& awk -F"\t" 'FNR==NR{a[$1]=$2; next}{ if(index($0, "analysisId") == 1) {print $0"\tBTG_Concensus"} else if (length(a[$5"-"$6"-"$7"-"$8"-"$16]) == 0) { print $0"\t." } else { print $0"\t"a[$5"-"$6"-"$7"-"$8"-"$16] }}' ${this._clinvarBTG} ${this.vcfHGMDFile}  > ${this.vcfHGMDFile}_temp && mv -f ${this.vcfHGMDFile}_temp ${this.vcfHGMDFile} `

                        clinVarCommand += BTGConcensusCommand;

                        // Add cosmic
                        let addCosmicID = `&& awk -F"\t" 'BEGIN{OFS="\t"}FNR==NR{a[$2]=$1; next}{if(length(a[$14]) == 0){ print $0; } else { if (a[$14] == $16) { print $0; } else { $14 = "."; print $0;}  } }' ${this._cosmic} ${this.vcfHGMDFile} > ${this.annoFile} `

                        // Add HGMD
                        let hgmdCommand = `&& awk -F"\t" 'BEGIN{OFS="\t"}FNR==NR{a[$1"_"$2"_"$3"_"$4"_"$5]=$6; next}{ if(index($0, "analysisId") == 1) {print $0"\tHGMD"} else if (length(a[$83]) == 0) { print $0"\t."; } else { print $0"\tDM"; }}' ${this._hgmdPath} ${this.annoFile} > ${this.vcfHgmdClinvarFile}`

                        let removeCommand = `rm -f ${this.annoFile} && rm -f ${this.vcfTranscriptFile}`

                        let command = `${tabixComand}${clearRefAlt}${clinVarCommand} ${addCosmicID} ${hgmdCommand}`

                        console.log('Command: ', command);

                        exec(command, (error, stdout, stderr) => {
                            if (error) {
                                this.logger.error('Read VCF error', error)
                                return reject(false);
                            }

                            this.logger.log('Read VCF Success')
                            return resolve(true)
                        })
                    }
                })
        });
    }

    async classifyVariant() {
        this.logger.log(`Classifying variants`);
        return new Promise((resolve, reject) => {
            let lineIndex = null;
            this.classifyStream = fs.createReadStream(this.vcfHgmdClinvarFile)
                .pipe(es.split())
                .pipe(es.mapSync((line) => {
                    this.classifyStream.pause();
                    let lineData = line.split('\t');

                    if (lineIndex == null) {
                        this.classifyStream.headings = line.split('\t');
                        lineIndex = 0;
                        fs.appendFileSync(this.annoVepFile, line + '\n');
                    } else if (lineData.length > 5) {
                        let CLINSIG = this.calculateService.formatCLINSIG(lineData[this.classifyStream.headings.indexOf('CLINSIG')]);
                        let codingEffect = lineData[this.classifyStream.headings.indexOf('codingEffect')];
                        let gene = lineData[this.classifyStream.headings.indexOf('gene')];
                        let CLNSIG_ID = lineData[this.classifyStream.headings.indexOf('CLNACC')];
                        let BTG_CLINSIG = lineData[this.classifyStream.headings.indexOf('CLNSIG_BTG')]
                        let BTG_Concensus = lineData[this.classifyStream.headings.indexOf('BTG_Concensus')];
                        let GoldStars = lineData[this.classifyStream.headings.indexOf('gold_stars')];
                        let VAR_SCORE = lineData[this.classifyStream.headings.indexOf('VAR_SCORE')];
                        let Curation = lineData[this.classifyStream.headings.indexOf('curation')];

                        let alleleFrequencyData = {
                            BTG_Concensus: BTG_Concensus,
                            GoldStars: GoldStars != '.' ? parseInt(GoldStars) : 0,
                            VAR_SCORE: GoldStars != '.' ? parseFloat(VAR_SCORE) : 0,
                            Curation: Curation != '.' ? Curation : '.',
                            AF: lineData[this.classifyStream.headings.indexOf('alleleFrequency')],
                            gnomAD_exome_ALL: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_ALL')],
                            gnomAD_exome_AFR: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_AFR')],
                            gnomAD_exome_AMR: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_AMR')],
                            gnomAD_exome_ASJ: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_ASJ')],
                            gnomAD_exome_EAS: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_EAS')],
                            gnomAD_exome_FIN: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_FIN')],
                            gnomAD_exome_NFE: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_NFE')],
                            gnomAD_exome_OTH: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_OTH')],
                            gnomAD_exome_SAS: lineData[this.classifyStream.headings.indexOf('gnomAD_exome_SAS')],
                            ExAC_ALL: lineData[this.classifyStream.headings.indexOf('ExAC_ALL')],
                            ExAC_AFR: lineData[this.classifyStream.headings.indexOf('ExAC_AFR')],
                            ExAC_AMR: lineData[this.classifyStream.headings.indexOf('ExAC_AMR')],
                            ExAC_EAS: lineData[this.classifyStream.headings.indexOf('ExAC_EAS')],
                            ExAC_FIN: lineData[this.classifyStream.headings.indexOf('ExAC_FIN')],
                            ExAC_NFE: lineData[this.classifyStream.headings.indexOf('ExAC_NFE')],
                            ExAC_OTH: lineData[this.classifyStream.headings.indexOf('ExAC_OTH')],
                            ExAC_SAS: lineData[this.classifyStream.headings.indexOf('ExAC_SAS')],
                            AF_1000g: lineData[this.classifyStream.headings.indexOf('AF')],
                            EAS_AF_1000g: lineData[this.classifyStream.headings.indexOf('1000g_EAS_AF')],
                            AMR_AF_1000g: lineData[this.classifyStream.headings.indexOf('1000g_AMR_AF')],
                            AFR_AF_1000g: lineData[this.classifyStream.headings.indexOf('1000g_AFR_AF')],
                            EUR_AF_1000g: lineData[this.classifyStream.headings.indexOf('1000g_EUR_AF')],
                            SAS_AF_1000g: lineData[this.classifyStream.headings.indexOf('1000g_SAS_AF')],
                            varLocation: lineData[this.classifyStream.headings.indexOf('varLocation')],
                        };

                        let classificationData = this.calculateService.calculateClinsigFinal(CLINSIG, alleleFrequencyData, codingEffect, gene, BTG_CLINSIG);

                        lineData[this.classifyStream.headings.indexOf('CLINSIG_PRIORITY')] = classificationData.CLINSIG_PRIORITY;
                        lineData[this.classifyStream.headings.indexOf('CLINSIG_FINAL')] = classificationData.CLINSIG_FINAL;
                        lineData[this.classifyStream.headings.indexOf('hasClinicalSynopsis')] = classificationData.hasClinicalSynopsis;
                        lineData[this.classifyStream.headings.indexOf('lossOfFunction')] = classificationData.lossOfFunction;
                        lineData[this.classifyStream.headings.indexOf('CLINSIG')] = CLINSIG;
                        lineData[this.classifyStream.headings.indexOf('CLINVAR_CLNSIG')] = CLINSIG;
                        lineData[this.classifyStream.headings.indexOf('Clinvar_VARIANT_ID')] = CLNSIG_ID;

                        // if (classificationData.curation == 'Curated') {
                        //     lineData[this.classifyStream.headings.indexOf('curation')] = 'Curated ';
                        // }

                        fs.appendFileSync(this.annoVepFile, lineData.join('\t') + '\n');
                    }

                    this.classifyStream.resume();
                }))
                .on('error', (error) => {
                    this.classifyStream.hasError = true;
                    this.logger.error('classifyVariant error', error);
                    this.classifyStream.destroy();
                })
                .on('close', () => {
                    if (this.classifyStream.hasError) {
                        return reject(false);
                    } else {
                        this.logger.log('Classify Variant completed');
                        return resolve(true);
                    }
                })
        })
    }

    async uploadFiles() {
        let commands = [
            `cd ${this.s3Dir}`,
            `cp ${this.annoVepFile} ${this.analysisFolder}/${RESULT_ANNO_FILE}`,
            `cp ${this.canonicalFile} ${this.analysisFolder}/${RESULT_CANONICAL_FILE}`
        ]

        await this.commonService.runCommand(commands.join(' && '));
    }

    analyzeLine(line: string) {
        if (line) {
            let data = line.split('\t');

            let chromIndex = this.headings.indexOf('#CHROM');
            let inputPosIndex = this.headings.indexOf('POS');
            let altIndex = this.headings.indexOf('ALT');
            let refIndex = this.headings.indexOf('REF');
            let qualIndex = this.headings.indexOf('QUAL');
            let filterIndex = this.headings.indexOf('FILTER');
            let infoIndex = this.headings.indexOf('INFO');

            let result = this.calculateData(data);
            result.analysisId = this.analysisId;
            result.REF = data[refIndex];
            result.QUAL = data[qualIndex];
            result.FILTER = data[filterIndex];
            result.INFO = infoIndex !== -1 ? (data[infoIndex] ?? '') : '';

            if (typeof result.INFO === 'string' && result.INFO.indexOf(';CSQ=') != -1) {
                let vepRL = result.INFO.split(';CSQ=')[1];
                let geneTranscipt = vepRL.split('|')[6];
                result.MT = geneTranscipt;
            }

            result.ALT = altIndex !== -1 && data[altIndex] != null ? data[altIndex].split(',') : ['.'];
            result.chrom = data[chromIndex];
            result.inputPos = data[inputPosIndex];

            return result
        }

        return false
    }

    writeAfVcf(line: string, extraData: any) {
        let infoIndex = this.headings.indexOf('INFO');
        let data = line.split('\t');
        if (infoIndex === -1 || data[infoIndex] == null) {
            fs.appendFileSync(this.AfVcfFile, data.join('\t') + '\n');
            return;
        }

        let infoData = data[infoIndex].split(';');
        let checkExist = false;

        for (var i in infoData) {
            if (typeof infoData[i] === 'string' && infoData[i].indexOf('AF=') == 0 && extraData.alleleFrequency != null) {
                let AF = Math.round(extraData.alleleFrequency * 1000) / 1000;
                infoData[i] = `AF=${AF}`;
                data[infoIndex] = infoData.join(';');
            }

            if (typeof infoData[i] === 'string' && infoData[i].indexOf('AF=') == 0) {
                checkExist = true;
            }
        }

        if (checkExist == false) {
            let AF = Math.round(extraData.alleleFrequency * 1000) / 1000;
            infoData.push(`AF=${AF}`);
            data[infoIndex] = infoData.join(';');
            this.checkAF = false;
        }

        fs.appendFileSync(this.AfVcfFile, data.join('\t') + '\n');
    }

    resumeAnnoStream() {
        if (this.annoStream) {
            this.annoStream.resume();
        } else {
            this.readAnno();
        }
    }

    readAnno() {
        this.annoArray = []
        this.annoStream = fs.createReadStream(this.originAnnoFile)
            .pipe(es.split())
            .pipe(es.mapSync((line) => {
                this.annoStream.pause()

                if (!this.annoStream.passedHeading) {

                    if (line.search('#CHROM') == 0) {
                        this.annoStream.passedHeading = true
                        this.annoStream.headings = line.split('\t')

                        let annoHeadings = [
                            "analysisId",
                            "readDepth",
                            "alleleFrequency",
                            "coverage",
                            "chrom",
                            "inputPos",
                            "REF",
                            "ALT",
                            "rsId",
                            "transcript",
                            "nucChange",
                            "cNomen",
                            "pNomen",
                            "cosmicIds",
                            "clinVarIds",
                            "gene",
                            "codingEffect",
                            "varLocation",
                            "ExAC_ALL",
                            "ExAC_AFR",
                            "ExAC_AMR",
                            "ExAC_EAS",
                            "ExAC_FIN",
                            "ExAC_NFE",
                            "ExAC_OTH",
                            "ExAC_SAS",
                            "gnomAD_exome_ALL",
                            "gnomAD_exome_AFR",
                            "gnomAD_exome_AMR",
                            "gnomAD_exome_ASJ",
                            "gnomAD_exome_EAS",
                            "gnomAD_exome_FIN",
                            "gnomAD_exome_NFE",
                            "gnomAD_exome_OTH",
                            "gnomAD_exome_SAS",
                            "SIFT_score",
                            "Polyphen2_HDIV_score",
                            "CADD_phred",
                            "CADD_raw",
                            "CLINSIG",
                            "1000g_AF",
                            "1000g_EAS_AF",
                            "1000g_AMR_AF",
                            "transcriptIds",
                            "cosmics",
                            "chrom_pos_ref_alt_gene",
                            "#Chr_Start_Ref_Alt_Ref.Gene",
                            "Consequence",
                            "varHGVSc",
                            "varHGVSp",
                            "EXON",
                            "INTRON",
                            "DOMAINS",
                            "1000g_AFR_AF",
                            "1000g_EUR_AF",
                            "1000g_SAS_AF",
                            "AA_AF",
                            "EA_AF",
                            "MAX_AF",
                            "MAX_AF_POPS",
                            "SOMATIC",
                            "PHENO",
                            "PUBMED",
                            "MOTIF_NAME",
                            "MOTIF_POS",
                            "HIGH_INF_POS",
                            "MOTIF_SCORE_CHANGE",
                            "CADD_PHRED",
                            "CADD_RAW",
                            "CANONICAL",
                            "CLINSIG_PRIORITY",
                            "CLINSIG_FINAL",
                            "hasClinicalSynopsis",
                            "lossOfFunction",
                            "inputPosInt",
                            "gnomAD_exome_ALL_Int",
                            "gnomAD_exome_AFR_Int",
                            "gnomAD_exome_AMR_Int",
                            "CDS_position",
                            "selected_variant",
                            "HGNC_SYMONYMS",
                            "HGNC_PRE_SYMBOL",
                            "VariantMatching",
                            "withdrawn_gene",
                            "SIFT",
                            "Polyphen2",
                            "gnomAD_genome_ALL",
                            "gnomAD_genome_AFR",
                            "gnomAD_genome_AMR",
                            "gnomAD_genome_ASJ",
                            "gnomAD_genome_EAS",
                            "gnomAD_genome_FIN",
                            "gnomAD_genome_NFE",
                            "gnomAD_genome_OTH",
                            "gnomADe_ALL",
                            "gnomADe_AFR",
                            "gnomADe_AMR",
                            "gnomADe_ASJ",
                            "gnomADe_EAS",
                            "gnomADe_FIN",
                            "gnomADe_NFE",
                            "gnomADe_OTH",
                            "gnomADe_SAS",
                            "Clinvar_VARIANT_ID",
                            "masterMind_MMID3",
                            "masterMind_MMCNT3",
                            "masterMind_GENE",
                            "GeneSplicer",
                            "IMPACT",
                            "STRAND",
                            "VARIANT_CLASS",
                            "VAR_GENE",
                            "VAR_SCORE",
                            "QUAL",
                            "FILTER",
                            "GT",
                            "Trimmed_variant",
                            "AF_hom",
                            "AF_het",
                            "pop_AF_hom",
                            "pop_AF_het"
                        ]

                        this.annoStream.firstLine = true;

                        fs.appendFileSync(this.annoFile, annoHeadings.join('\t'))
                    }

                    this.annoStream.resume()
                } else {
                    let lineData = line.split('\t')

                    if (line && this.annoStream.firstLine) {
                        this.annoStream.firstLine = false;

                        this.annoStream.currentChrom = lineData[this.annoStream.headings.indexOf('#CHROM')];
                        this.annoStream.currentAllele = lineData[this.annoStream.headings.indexOf('ALT')];
                        this.annoStream.currentRef = lineData[this.annoStream.headings.indexOf('REF')];
                        this.annoStream.currentPos = lineData[this.annoStream.headings.indexOf('POS')];

                        this.annoArray.push(line)
                        return this.annoStream.resume()
                    }

                    if (line) {

                        let lineCHROM = lineData[this.annoStream.headings.indexOf('#CHROM')];
                        let linePOS = lineData[this.annoStream.headings.indexOf('POS')];
                        let lineREF = lineData[this.annoStream.headings.indexOf('REF')];
                        let lineALT = lineData[this.annoStream.headings.indexOf('ALT')];

                        if (this.vcfStream.extraData && (
                            lineCHROM == this.annoStream.currentChrom && linePOS == this.annoStream.currentPos && lineREF == this.annoStream.currentRef && lineALT == this.annoStream.currentAllele
                        ) && (
                                this.vcfStream.extraData.inputPos == linePOS && this.vcfStream.extraData.REF == lineREF && this.vcfStream.extraData.ALT == lineALT && this.vcfStream.extraData.chrom == lineCHROM
                            )
                        ) {
                            this.annoArray.push(line)
                            return this.annoStream.resume()
                        } else {

                            this.annoStream.currentChrom = lineCHROM
                            this.annoStream.currentAllele = lineALT
                            this.annoStream.currentPos = linePOS
                            this.annoStream.currentRef = lineREF

                            this.filterVariant(this.annoArray, this.vcfStream.extraData);

                            this.annoArray = []
                            this.annoArray.push(line)

                            return this.vcfStream.resume()
                        }

                    } else {
                        return this.annoStream.resume()
                    }
                }
            }))
            .on('error', (error) => {
                console.log('Read anno error', error)
                this.vcfStream.hasError = true
                // return this.vcfEvents.emit('completed', false)
                return this.vcfStream.destroy()
            })
            .on('end', () => {
                this.filterVariant(this.annoArray, this.vcfStream.extraData);

                if (!this.vcfStream.ended) {
                    this.vcfStream.ended = true
                    this.vcfStream.destroy()
                }
            })
    }

    calculateData(data: string[]) {
        let chromIndex = this.headings.indexOf('#CHROM')
        let formatIndex = this.headings.indexOf('FORMAT')
        let infoIndex = this.headings.indexOf('INFO')
        let infoValue = infoIndex !== -1 ? (data[infoIndex] ?? '') : '';
        let variantIndex = infoValue ? this.calculateService.getExtraData2('VARINDEX', infoValue) : null;
        let vcfAF = infoValue ? this.calculateService.getExtraData2('AF', infoValue) : null;

        // Ugly check if this is a variant row
        let chrom = chromIndex !== -1 ? (data[chromIndex] ?? '') : ''
        if (!chrom) {
            return {
                readDepth: null,
                alleleFrequency: null,
                coverage: null
            }
        }

        if (chrom.indexOf('##') == 0) {
            return {
                readDepth: null,
                alleleFrequency: null,
                coverage: null
            }
        }

        /**
         * Supported VCF types
         * Each has a diffirent calculation for read depth
         * 1. Unified
         *     Column "FORMAT" -> GT:AD:DP:GQ:PL
         * 2. LoFeq
         *     No Column "FORMAT"
         * 3. VarDict
         *     Column "FORMAT" -> GT:DP:VD:AD:AF:RD:ALD
         * 4. Laura (Umm....)
         *     Column "FORMAT" contains SGCOUNTREF_F:SGCOUNTREF_R:SGCOUNTALT_F:SGCOUNTALT_R
         * TODO: Stop process and raise error if format is not supported
         */
        if (formatIndex == -1) {
            // return this.calculateLoFeqData(data[infoIndex])
            return {
                GT: null,
                readDepth: null,
                alleleFrequency: null,
                coverage: null
            }
        } else {
            let format = data[formatIndex]
            let formatData = data[formatIndex + 1]
            let result

            if (typeof format !== 'string' || format.length === 0) {
                return {
                    readDepth: null,
                    alleleFrequency: null,
                    coverage: null
                }
            }

            if (format == 'GT:AD:DP:GQ:PL'
                || format == 'GT:AD:DP:GQ:PGT:PID:PL'
                || format == 'GT:AD:GQ:PL'
                || format == 'GT:AD:GQ:PGT:PID:PL'
                || format == 'GT:AD:DP:GQ:PL:VF:GQX'
                || format == 'GT:AD:AF:DP:GQ:PL:GL:GP:PRI:SB:MB'
                || format.indexOf('GT:AD:DP:GQ') == 0
                || format.indexOf('GT:AD:AF:AFDP:ALTHC') == 0
                || format == 'GT:AD:AF:DP:F1R2:F2R1:GQ:PL:GP:PRI:SB:MB'
                || format == 'GT:AD:AF:DP:F1R2:F2R1:GQ:PL:GP:PRI:SB:MB:PS'
                || format == 'GT:AD:AF:F1R2:F2R1:DP:SB:MB'
                || format == 'GT:AD:AQ:DP:GQ:LQ:NC:NL:SB:US:VF'
                || format == 'GT:AD:AF:DP:F1R2:F2R1:GQ:PL:GP:PRI:SB:MB'
                || format == 'GT:AD:AF:DP:F1R2:F2R1:GQ:PL:GP:PRI:SB:MB:PS'
                || format == 'GT:AD:AF:F1R2:F2R1:DP:SB:MB'
                || format == 'GT:AD:AF:F1R2:F2R1:DP:SB:MB:PS'
            ) {
                result = this.calculateService.calculateUnifiedData(format, formatData);
            } else if (format == 'GT:GQ:GQX:DPI:AD' || format == 'GT:GQ:GQX:DP:DPF:AD' || format == 'GT:GQ:GQX:DP:DPF:AD:ADF:ADR:SB:FT:PL' || format == 'GT:GQ:GQX:DP:DPF:AD:ADF:ADR:SB:FT:PL:PS' || format == 'GT:GQ:GQX:DPI:AD:ADF:ADR:FT:PL' || format == 'GT:GQ:GQX:DPI:AD:ADF:ADR:FT:PL:PS') {
                result = this.calculateService.calculateUnifiedData2(format, formatData);
            } else if (format == 'GT:DP:VD:AD:AF:RD:ALD') {
                result = this.calculateService.calculateVarDictData(formatData);
            } else if (format == 'GT:GQ:DP:AD:VAF:PL' || format.indexOf('GT:GQ:DP:AD') == 0) {
                result = this.calculateService.calculateAgiomixData(formatData);
            } else if (format == 'GT:GQ:AD:DP:VF:NL:SB:NC:US:AQ:LQ' || format == 'GT:SQ:AD:AF:F1R2:F2R1:DP:SB:MB' || format == 'GT:SQ:AD:AF:F1R2:F2R1:DP:SB:MB:PS') {
                result = this.calculateService.calculateUnifiedData3(format, formatData);
            } else if (format.indexOf('SGCOUNTREF_F:SGCOUNTREF_R:SGCOUNTALT_F:SGCOUNTALT_R') != -1) {
                result = this.calculateService.calculateLauraData(format, formatData);
            } else if (format == 'GT:GQ:DP:FDP:RO:FRO:AO:FAO:AF:SAR:SAF:SRF:SRR:FSAR:FSAF:FSRF:FSRR') {
                result = this.calculateService.calculateTorrentA(formatData, variantIndex);
            } else if (format == 'GT:GQ:DP:FDP:RO:FRO:AO:FAO:SAR:SAF:SRF:SRR:FSAR:FSAF:FSRF:FSRR') {
                result = this.calculateService.calculateTorrentA2(formatData, variantIndex);
            } else if (format == 'GT:AF:AO:DP:FAO:FDP:FRO:FSAF:FSAR:FSRF:FSRR:GQ:RO:SAF:SAR:SRF:SRR') {
                result = this.calculateService.calculateTorrentB(formatData, variantIndex);
            } else if (format == 'GT:AO:DP:FAO:FDP:FRO:FSAF:FSAR:FSRF:FSRR:GQ:RO:SAF:SAR:SRF:SRR') {
                result = this.calculateService.calculateTorrentB2(formatData, variantIndex);
            } else if (format == 'GT:GQ:DP:RO:AO:SAR:SAF:SRF:SRR') {
                result = this.calculateService.calculateTorrentC(formatData, variantIndex);
            } else if (format == 'GT:DP:ADALL:AD:GQ:IGT:IPS:PS') {
                result = this.calculateService.calculateOtherData(formatData);
            } else if (format == 'GT:PS:DP:ADALL:AD:GQ') {
                result = this.calculateService.calculateOtherData3(formatData);
            } else if (format.split(':').length > 0 && format.split(':').indexOf('AD') != -1) {
                result = this.calculateService.calculateOtherData4(format, formatData);
            } else if (format == 'GT') {
                result = {
                    readDepth: null,
                    alleleFrequency: null,
                    coverage: null
                }
                if (vcfAF != null) {
                    variantIndex = parseInt(variantIndex);
                    result.alleleFrequency = vcfAF.split(',')[variantIndex - 1]
                }
            } else if (format == 'GT:GQ') {
                result = {
                    GT: formatData.split(":")[0],
                    readDepth: null,
                    alleleFrequency: null,
                    coverage: null
                }
                if (['0/1', '0/2', '0/3'].indexOf(result.GT) != -1) {
                    result.alleleFrequency = 0.5
                } else if (['1/1', '2/2', '3/3'].indexOf(result.GT) != -1) {
                    result.alleleFrequency = 1
                }
            }
            else {
                result = {
                    readDepth: null,
                    alleleFrequency: null,
                    coverage: null
                }
            }

            return result;
        }
    }

    filterVariant(annoArray: string[], vcfExtraData: any) {
        let NM_Array = [];
        let NR_Array = [];
        let ENST_Array = [];
        let Other_Array = [];
        let Gene_Array = [];

        let line = '';
        let transcriptArray = [];

        let refseqGene = []

        for (var i in annoArray) {
            line = annoArray[i];
            let lineData = line.split('\t');

            let transcript = lineData[this.annoStream.headings.indexOf('Feature')];
            let geneName = this.calculateService.formatData(this.calculateService.getGeneSymbol(lineData, this.annoStream.headings));
            let geneColumn = this.calculateService.formatData(lineData[this.annoStream.headings.indexOf('Gene')]);
            let varHGVSc = lineData[this.annoStream.headings.indexOf('HGVSc')];
            let varHGVSp = lineData[this.annoStream.headings.indexOf('HGVSp')];
            let cNomen = '.';
            let pNomen = '.';

            if (varHGVSc != null) {
                let cNomenArray = varHGVSc.split(':');
                if (cNomenArray[1] != undefined) {
                    cNomen = cNomenArray[1];
                }
            }

            if (varHGVSp != null) {
                let pNomenArray = varHGVSp.split(':');
                if (pNomenArray[1] != undefined) {
                    pNomen = pNomenArray[1];
                    pNomen = pNomen.replace("%3D", "=");
                }
            }

            transcriptArray.push(transcript + ':' + geneColumn + ':' + this.calculateService.formatData(geneName) + ':' + cNomen + ':' + pNomen);

            if (transcript.indexOf('NM') != -1) {
                NM_Array.push(line)
                if (refseqGene.indexOf(geneName) == -1 && geneName.indexOf('withdrawn') == -1) {
                    refseqGene.push(geneName)
                }
            } else if (transcript.indexOf('NR') != -1) {
                NR_Array.push(line)
                if (refseqGene.indexOf(geneName) == -1 && geneName.indexOf('withdrawn') == -1) {
                    refseqGene.push(geneName)
                }
            } else if (transcript.indexOf('ENST') != -1) {
                ENST_Array.push(line)
            } else {
                Other_Array.push(line)
            }

            if (Gene_Array.indexOf(geneName) == -1) {
                Gene_Array.push(geneName)
            }
        }

        let checkAllWithdrawn = true;
        for (var i in Gene_Array) {
            if (Gene_Array[i].indexOf('withdrawn') == -1) {
                checkAllWithdrawn = false;
            }
        }

        if (Gene_Array.length == 1 || checkAllWithdrawn == true) {
            var geneLine = this.selectLongestTranscriptByGene(NM_Array, NR_Array, ENST_Array, Other_Array, Gene_Array[0]);
            vcfExtraData.gene = Gene_Array[0];
            let selectedGene = 1;
            if (geneLine == '') {
                this.logger.error('geneLine False')
                this.logger.error('VCF')
                this.logger.error(JSON.stringify(vcfExtraData))
                this.logger.error('gene: ' + Gene_Array[0])
                this.logger.error('Anno Array: ')
                this.logger.error(JSON.stringify(annoArray))
            }

            if (geneLine != '') {
                this.appendToAnnoFile(geneLine, vcfExtraData, transcriptArray.join('|'), selectedGene);
            }
        } else {
            let selectedGene = 0;

            if ((vcfExtraData.chrom == 'MT' || vcfExtraData.chrom == 'M' || vcfExtraData.chrom == 'chrM' || vcfExtraData.chrom == 'chrMT') && vcfExtraData.INFO.indexOf(';CSQ=') != -1) {
                if (vcfExtraData.MT == '' || vcfExtraData.MT == null) {
                    selectedGene = 1;
                }
            } else if (refseqGene.length == 0) {
                selectedGene = 1;
            }
            for (var i in Gene_Array) {
                if (Gene_Array[i].indexOf('withdrawn') == -1) {
                    var geneLine = this.selectLongestTranscriptByGene(NM_Array, NR_Array, ENST_Array, Other_Array, Gene_Array[i]);
                    vcfExtraData.gene = Gene_Array[i];

                    if (geneLine == '') {
                        this.logger.error('geneLine False')
                        this.logger.error('VCF')
                        this.logger.error(JSON.stringify(vcfExtraData))
                        this.logger.error('gene: ' + Gene_Array[i])
                        this.logger.error('Anno Array: ')
                        this.logger.error(JSON.stringify(annoArray))
                    }

                    if (geneLine != '') {
                        if ((vcfExtraData.chrom == 'MT' || vcfExtraData.chrom == 'M' || vcfExtraData.chrom == 'chrM' || vcfExtraData.chrom == 'chrMT') && vcfExtraData.INFO.indexOf(';CSQ=') != -1) {
                            if (geneLine.indexOf(vcfExtraData.MT) != -1) {
                                selectedGene = 1;
                            }
                        } else {
                            if (refseqGene.length > 0 && Gene_Array[i] == refseqGene[0]) {
                                selectedGene = 1;
                            }
                        }

                        this.appendToAnnoFile(geneLine, vcfExtraData, transcriptArray.join('|'), selectedGene);
                        if (selectedGene == 1) {
                            selectedGene = 0
                        }
                    }
                }
            }
        }
    }

    appendToAnnoFile(line, vcfExtraData, transcriptIds, selectedGene) {
        let lineData = line.split('\t');
        let extraData = lineData;

        let transcript = this.calculateService.formatData(lineData[this.annoStream.headings.indexOf('Feature')]);
        let codingEffect = this.calculateService.getCodingEffect(lineData[this.annoStream.headings.indexOf('Consequence')]);
        let varLocation = this.calculateService.getVarLocation(lineData[this.annoStream.headings.indexOf('Consequence')]);
        let Consequence = this.calculateService.formatData(lineData[this.annoStream.headings.indexOf('Consequence')]);
        let CDS_position = this.calculateService.formatData(lineData[this.annoStream.headings.indexOf('CDS_position')]);
        let varHGVSc = lineData[this.annoStream.headings.indexOf('HGVSc')];
        let varHGVSp = lineData[this.annoStream.headings.indexOf('HGVSp')];
        let STRAND = lineData[this.annoStream.headings.indexOf('STRAND')];
        let cosmic = '.';
        let cosmicIds = '.';
        let CLINSIG = this.calculateService.formatData(lineData[this.annoStream.headings.indexOf('CLIN_SIG')]);
        let cNomen = '.';
        let pNomen = '.';
        let gene = this.calculateService.formatData(this.calculateService.getGeneSymbol(extraData, this.annoStream.headings));
        let withdrawnGene = 0;

        if (gene.indexOf('~withdrawn') != -1) {
            gene = gene.split('~withdrawn')[0];
            withdrawnGene = 1;
        }

        if (varHGVSc != null) {
            let cNomenArray = varHGVSc.split(':');
            if (cNomenArray[1] != undefined) {
                cNomen = cNomenArray[1];
            }
        }

        if (varHGVSp != null) {
            let pNomenArray = varHGVSp.split(':');
            if (pNomenArray[1] != undefined) {
                pNomen = pNomenArray[1];
                pNomen = pNomen.replace("%3D", "=");
            }
        }

        vcfExtraData.chrom = vcfExtraData.chrom.split('chr').join('');
        let vepPOS = lineData[this.annoStream.headings.indexOf('POS')];
        let vepChrom = lineData[this.annoStream.headings.indexOf('#CHROM')].split('chr').join('');
        let vepALT = lineData[this.annoStream.headings.indexOf('ALT')];
        let vepREF = lineData[this.annoStream.headings.indexOf('REF')];
        let vcfDataIndex = vcfExtraData.chrom + '_' + vcfExtraData.inputPos + '_' + vcfExtraData.REF + '_' + vcfExtraData.ALT + '_' + gene;
        let deletionNucle = this.calculateService.getDeletion(vcfExtraData.REF, vcfExtraData.ALT[0], STRAND);

        if (cNomen != '.' && deletionNucle != '' && cNomen.substr(cNomen.length - 3) == 'del') {
            cNomen = cNomen + deletionNucle;
        }

        let vepDataIndex = vepChrom + '_' + vepPOS + '_' + vepREF + '_' + vepALT + '_' + gene;
        let Variant_ID = this.getExtraValue(lineData, 'Clinvar_VARIANT_ID');
        let AF_1000g = this.getExtraValue(lineData, 'AF');
        let EAS_AF_1000g = this.getExtraValue(lineData, 'EAS_AF');
        let AMR_AF_1000g = this.getExtraValue(lineData, 'AMR_AF');
        let AFR_AF_1000g = this.getExtraValue(lineData, 'AFR_AF');
        let EUR_AF_1000g = this.getExtraValue(lineData, 'EUR_AF');
        let SAS_AF_1000g = this.getExtraValue(lineData, 'SAS_AF');
        let AA_AF = this.getExtraValue(lineData, 'AA_AF');
        let EA_AF = this.getExtraValue(lineData, 'EA_AF');
        CLINSIG = this.calculateService.formatCLINSIG(CLINSIG);

        let alleleFrequencyData = {
            AF: vcfExtraData.alleleFrequency,
            gnomAD_exome_ALL: this.getExtraValue(extraData, 'gnomADe_AF'),
            gnomAD_exome_AFR: this.getExtraValue(extraData, 'gnomADe_AFR_AF', 'gnomADe_AF_afr'),
            gnomAD_exome_AMR: this.getExtraValue(extraData, 'gnomADe_AMR_AF', 'gnomADe_AF_amr'),
            gnomAD_exome_ASJ: this.getExtraValue(extraData, 'gnomADe_ASJ_AF', 'gnomADe_AF_asj'),
            gnomAD_exome_EAS: this.getExtraValue(extraData, 'gnomADe_EAS_AF', 'gnomADe_AF_eas'),
            gnomAD_exome_FIN: this.getExtraValue(extraData, 'gnomADe_FIN_AF', 'gnomADe_AF_fin'),
            gnomAD_exome_NFE: this.getExtraValue(extraData, 'gnomADe_NFE_AF', 'gnomADe_AF_nfe'),
            gnomAD_exome_OTH: this.getExtraValue(extraData, 'gnomADe_REMAINING_AF', 'gnomADe_AF_oth'),
            gnomAD_exome_SAS: this.getExtraValue(extraData, 'gnomADe_SAS_AF', 'gnomADe_AF_sas'),
            gnomAD_genome_ALL: this.getExtraValue(extraData, 'gnomADg_AF'),
            gnomAD_genome_AFR: this.getExtraValue(extraData, 'gnomADg_AFR_AF', 'gnomADg_AF_afr'),
            gnomAD_genome_AMR: this.getExtraValue(extraData, 'gnomADg_AMR_AF', 'gnomADg_AF_amr'),
            gnomAD_genome_ASJ: this.getExtraValue(extraData, 'gnomADg_ASJ_AF', 'gnomADg_AF_asj'),
            gnomAD_genome_EAS: this.getExtraValue(extraData, 'gnomADg_EAS_AF', 'gnomADg_AF_eas'),
            gnomAD_genome_FIN: this.getExtraValue(extraData, 'gnomADg_FIN_AF', 'gnomADg_AF_fin'),
            gnomAD_genome_NFE: this.getExtraValue(extraData, 'gnomADg_NFE_AF', 'gnomADg_AF_nfe'),
            gnomAD_genome_OTH: this.getExtraValue(extraData, 'gnomADg_REMAINING_AF', 'gnomADg_AF_oth'),
            ExAC_ALL: this.calculateService.calculateExac('_Adj', extraData, this.annoStream.headings),
            ExAC_AFR: this.calculateService.calculateExac('_AFR', extraData, this.annoStream.headings),
            ExAC_AMR: this.calculateService.calculateExac('_AMR', extraData, this.annoStream.headings),
            ExAC_EAS: this.calculateService.calculateExac('_EAS', extraData, this.annoStream.headings),
            ExAC_FIN: this.calculateService.calculateExac('_FIN', extraData, this.annoStream.headings),
            ExAC_NFE: this.calculateService.calculateExac('_NFE', extraData, this.annoStream.headings),
            ExAC_OTH: this.calculateService.calculateExac('_OTH', extraData, this.annoStream.headings),
            ExAC_SAS: this.calculateService.calculateExac('_SAS', extraData, this.annoStream.headings),
            AF_1000g: this.getExtraValue(extraData, 'AF'),
            EAS_AF_1000g: this.getExtraValue(extraData, 'EAS_AF'),
            AMR_AF_1000g: this.getExtraValue(extraData, 'AMR_AF'),
            AFR_AF_1000g: this.getExtraValue(extraData, 'AFR_AF'),
            EUR_AF_1000g: this.getExtraValue(extraData, 'EUR_AF'),
            SAS_AF_1000g: this.getExtraValue(extraData, 'SAS_AF'),
        };

        let gnomAD_MAX_AF = this.calculateService.getMAX_AF(alleleFrequencyData);
        let MAX_AF = gnomAD_MAX_AF.MAX_AF;
        let MAX_AF_POPS = gnomAD_MAX_AF.MAX_AF_POPS;
        let SIFT_score = this.calculateService.formatData(this.calculateService.getExtraData('SIFT', extraData, this.annoStream.headings));
        let PolyPhen_score = this.calculateService.formatData(this.calculateService.getExtraData('PolyPhen', extraData, this.annoStream.headings));
        let SIFT_number = '.';

        if (SIFT_score != '.') {
            try {
                const siftParts = SIFT_score.split('(');
                if (siftParts.length > 1) {
                    SIFT_number = siftParts[1].split(')')[0];
                }
            } catch (error) {
                console.error('Error parsing SIFT score:', error);
            }
        }

        let PolyPhen_number = '.';

        if (PolyPhen_score != '.') {
            try {
                const polyPhenParts = PolyPhen_score.split('(');
                if (polyPhenParts.length > 1) {
                    PolyPhen_number = polyPhenParts[1].split(')')[0];
                }
            } catch (error) {
                console.error('Error parsing PolyPhen score:', error);
            }
        }

        let HGNC_SYMONYMS = this.getExtraValue(extraData, 'HGNC_SYNONYMS');
        let HGNC_PRE_SYMBOL = this.getExtraValue(extraData, 'HGNC_PRE_SYMBOL');
        let geneSplicer = this.getExtraValue(extraData, 'GeneSplicer');
        let IMPACT = this.getExtraValue(extraData, 'IMPACT');
        let VARIANT_CLASS = this.getExtraValue(extraData, 'VARIANT_CLASS');
        let VAR_GENE = this.getExtraValue(extraData, 'variantScore_VAR_GENE');
        let VAR_SCORE = this.getExtraValue(extraData, 'variantScore_VAR_SCORE');
        let VAR_GENE_VAL = '.';
        let VAR_SCORE_VAL = '.';

        let rsId = this.getExtraValue(extraData, 'dbSNP_RS');
        rsId = rsId != '.' ? ('rs' + rsId) : '.';
        let rsIdVep = this.calculateService.formatData(this.calculateService.getRsID(lineData[this.annoStream.headings.indexOf('Existing_variation')]));
        rsId = rsId != '.' ? rsId : rsIdVep;

        if (VAR_GENE != '.') {
            let VAR_GENE_AR = VAR_GENE.split(',');
            let VAR_SCORE_AR = VAR_SCORE.split(',');

            for (var i in VAR_GENE_AR) {
                if (VAR_GENE_AR[i] == gene) {
                    VAR_GENE_VAL = gene;
                    VAR_SCORE_VAL = VAR_SCORE_AR[i];
                }
            }
        }

        let TrimmedVariant = this.calculateService.convert(vcfExtraData.chrom, vcfExtraData.inputPos, vcfExtraData.REF, vcfExtraData.ALT[0], gene);

        let data = [
            vcfExtraData.analysisId,                                            //  analysisId
            vcfExtraData.readDepth,                                             //  readDepth
            vcfExtraData.alleleFrequency,                                       //  alleleFrequency
            vcfExtraData.coverage,                                              //  coverage
            vcfExtraData.chrom,                                                 //  chrom
            vcfExtraData.inputPos,                                              //  inputPos
            vcfExtraData.REF,                                                   //  REF
            vcfExtraData.ALT,                                                   //  ALT
            rsId,                                                               //  rsId
            transcript,                                                         //  transcript
            `${vcfExtraData.REF}>${vcfExtraData.ALT[0]}`,                       //  nucChange
            cNomen,                                                             //  cNomen
            pNomen,                                                             //  pNomen
            cosmic,                                                             //  cosmicIds
            '.',                                                                //  clinVarIds
            gene,                                                               //  gene
            codingEffect,                                                       //  codingEffect
            varLocation,                                                        //  varLocation
            alleleFrequencyData.ExAC_ALL,                                       //  ExAC_ALL
            alleleFrequencyData.ExAC_AFR,                                       //  ExAC_AFR
            alleleFrequencyData.ExAC_AMR,                                       //  ExAC_AMR
            alleleFrequencyData.ExAC_EAS,                                       //  ExAC_EAS
            alleleFrequencyData.ExAC_FIN,                                       //  ExAC_FIN
            alleleFrequencyData.ExAC_NFE,                                       //  ExAC_NFE
            alleleFrequencyData.ExAC_OTH,                                       //  ExAC_OTH
            alleleFrequencyData.ExAC_SAS,                                       //  ExAC_SAS
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_ALL, alleleFrequencyData.gnomAD_genome_ALL),    //  gnomAD_exome_ALL
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_AFR, alleleFrequencyData.gnomAD_genome_AFR),    //  gnomAD_exome_AFR
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_AMR, alleleFrequencyData.gnomAD_genome_AMR),    //  gnomAD_exome_AMR
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_ASJ, alleleFrequencyData.gnomAD_genome_ASJ),    //  gnomAD_exome_ASJ
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_EAS, alleleFrequencyData.gnomAD_genome_EAS),    //  gnomAD_exome_EAS
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_FIN, alleleFrequencyData.gnomAD_genome_FIN),    //  gnomAD_exome_FIN
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_NFE, alleleFrequencyData.gnomAD_genome_NFE),    //  gnomAD_exome_NFE
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_OTH, alleleFrequencyData.gnomAD_genome_OTH),    //  gnomAD_exome_OTH
            alleleFrequencyData.gnomAD_exome_SAS,                               //  gnomAD_exome_SAS
            this.getExtraValue(extraData, 'SIFT'),                                  //  SIFT_score
            this.getExtraValue(extraData, 'PolyPhen'),                              //  Polyphen2_HDIV_score
            this.getExtraValue(extraData, 'CADD_PHRED'),                            //  CADD_phred
            this.getExtraValue(extraData, 'CADD_RAW'),                              //  CADD_raw
            CLINSIG,                                                            //  CLINSIG
            AF_1000g,                                                           //  1000g_AF
            EAS_AF_1000g,                                                       //  1000g_EAS_AF
            AMR_AF_1000g,                                                       //  1000g_AMR_AF
            transcriptIds,                                                      //  transcriptIds
            cosmicIds,                                                          //  cosmics
            vcfDataIndex,                                                       //  vcfDataIndex
            vepDataIndex,                                                       //  vepDataIndex
            Consequence,                                                        //  Consequence
            varHGVSc,                                                           //  varHGVSc
            varHGVSp,                                                           //  varHGVSp
            this.getExtraValue(extraData, 'EXON'),                                  //  EXON
            this.getExtraValue(extraData, 'INTRON'),                                //  INTRON
            this.getExtraValue(extraData, 'DOMAINS'),                               //  DOMAINS
            AFR_AF_1000g,                                                       //  1000g_AFR_AF
            EUR_AF_1000g,                                                       //  1000g_EUR_AF
            SAS_AF_1000g,                                                       //  1000g_SAS_AF
            AA_AF,                                                              //  AA_AF
            EA_AF,                                                              //  EA_AF
            MAX_AF,                                                             //  MAX_AF
            MAX_AF_POPS,                                                        //  MAX_AF_POPS
            this.getExtraValue(extraData, 'SOMATIC'),                               //  SOMATIC
            this.getExtraValue(extraData, 'PHENO'),                                 //  PHENO
            this.getExtraValue(extraData, 'PUBMED'),                                //  PUBMED
            this.getExtraValue(extraData, 'MOTIF_NAME'),                            //  MOTIF_NAME
            this.getExtraValue(extraData, 'MOTIF_POS'),                             //  MOTIF_POS
            this.getExtraValue(extraData, 'HIGH_INF_POS'),                          //  HIGH_INF_POS
            this.getExtraValue(extraData, 'MOTIF_SCORE_CHANGE'),                    //  MOTIF_SCORE_CHANGE
            this.getExtraValue(extraData, 'CADD_PHRED'),                            //  CADD_PHRED
            this.getExtraValue(extraData, 'CADD_RAW'),                              //  CADD_RAW
            this.getExtraValue(extraData, 'CANONICAL'),                             //  CANONICAL
            '.',                                                                //  CLINSIG_PRIORITY
            '.',                                                                //  CLINSIG_FINAL
            '.',                                                                //  hasClinicalSynopsis
            '.',                                                                //  lossOfFunction
            vcfExtraData.inputPos,                                              //  inputPosInt
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_ALL, alleleFrequencyData.gnomAD_genome_ALL),  //  gnomAD_exome_ALL_Int
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_AFR, alleleFrequencyData.gnomAD_genome_AFR),  //  gnomAD_exome_AFR_Int
            this.calculateService.getGnomAD(alleleFrequencyData.gnomAD_exome_AMR, alleleFrequencyData.gnomAD_genome_AMR),  //  gnomAD_exome_AMR_Int
            CDS_position,                                                        //  CDS_position
            selectedGene,                                                        // selected_gene
            HGNC_SYMONYMS,                                                       // HGNC_SYMONYMS
            HGNC_PRE_SYMBOL,                                                     // HGNC_PRE_SYMBOL
            '.',                                                                 // VariantMatching
            withdrawnGene,                                                       // withdrawnGene
            SIFT_number,                                                         // "SIFT",
            PolyPhen_number,                                                     // "Polyphen2"
            alleleFrequencyData.gnomAD_genome_ALL,                               //"gnomAD_genome_ALL",
            alleleFrequencyData.gnomAD_genome_AFR,                               // gnomAD_genome_AFR
            alleleFrequencyData.gnomAD_genome_AMR,                               // gnomAD_genome_AMR
            alleleFrequencyData.gnomAD_genome_ASJ,                               // gnomAD_genome_ASJ
            alleleFrequencyData.gnomAD_genome_EAS,                               // gnomAD_genome_EAS
            alleleFrequencyData.gnomAD_genome_FIN,                               // gnomAD_genome_FIN
            alleleFrequencyData.gnomAD_genome_NFE,                               // gnomAD_genome_NFE
            alleleFrequencyData.gnomAD_genome_OTH,                               // gnomAD_genome_OTH
            alleleFrequencyData.gnomAD_exome_ALL,                                // gnomADe_ALL
            alleleFrequencyData.gnomAD_exome_AFR,                                // gnomADe_AFR
            alleleFrequencyData.gnomAD_exome_AMR,                                // gnomADe_AMR
            alleleFrequencyData.gnomAD_exome_ASJ,                                // gnomADe_ASJ
            alleleFrequencyData.gnomAD_exome_EAS,                                // gnomADe_EAS
            alleleFrequencyData.gnomAD_exome_FIN,                                // gnomADe_FIN
            alleleFrequencyData.gnomAD_exome_NFE,                                // gnomADe_NFE
            alleleFrequencyData.gnomAD_exome_OTH,                                // gnomADe_OTH
            alleleFrequencyData.gnomAD_exome_SAS,                                // gnomADe_SAS
            Variant_ID,                                                          // Clinvar_Variant_ID
            this.getExtraValue(extraData, 'masterMind_MMID3'),                   // masterMind_MMID3
            this.getExtraValue(extraData, 'masterMind_MMCNT3'),                  // masterMind_MMCNT3
            this.getExtraValue(extraData, 'masterMind_GENE'),                    // masterMind_GENE
            this.calculateService.formatData(geneSplicer),                       // GeneSplicer
            this.calculateService.formatData(IMPACT),                            // IMPACT
            this.calculateService.formatData(STRAND),                            // STRAND
            this.calculateService.formatData(VARIANT_CLASS),                     // VARIANT_CLASS
            this.calculateService.formatData(VAR_GENE_VAL),                                      // VAR_GENE
            this.calculateService.formatData(VAR_SCORE_VAL),                                     // VAR_SCORE
            this.calculateService.formatData(vcfExtraData.QUAL),                                 // QUAL
            this.calculateService.formatData(vcfExtraData.FILTER),                               // FILTER
            this.calculateService.formatData(vcfExtraData.GT),                                   // GT
            TrimmedVariant,                                                                      // Trimmed_variant
            this.getExtraValue(extraData, 'gnomMT_AF_hom'),                       // AF_hom
            this.getExtraValue(extraData, 'gnomMT_AF_het'),                       // AF_het
            this.getExtraValue(extraData, 'gnomMT_pop_AF_hom'),                   // pop_AF_hom
            this.getExtraValue(extraData, 'gnomMT_pop_AF_het'),                   // pop_AF_het
        ]

        fs.appendFileSync(this.annoFile, '\n' + data.join('\t'));
    }

    selectLongestTranscriptByGene(NM_Array, NR_Array, ENST_Array, Other_Array, geneName) {
        var maxGeneLine = ''

        if (NM_Array.length > 0) {
            maxGeneLine = this.selectLongestTranscript(NM_Array, geneName);
        }
        if (NR_Array.length > 0 && maxGeneLine == '') {
            maxGeneLine = this.selectLongestTranscript(NR_Array, geneName);
        }
        if (ENST_Array.length > 0 && maxGeneLine == '') {
            maxGeneLine = this.selectLongestTranscript(ENST_Array, geneName);
        }
        if (maxGeneLine == '') {
            maxGeneLine = this.selectLongestTranscript(Other_Array, geneName);
        }

        return maxGeneLine;
    }

    selectLongestTranscript(transcriptArray, geneName) {
        var resultArray = []
        for (var i in transcriptArray) {
            let line = transcriptArray[i];
            let lineData = line.split('\t');
            let symbol = this.calculateService.formatData(this.calculateService.getGeneSymbol(lineData, this.annoStream.headings));

            if (symbol == geneName) {
                resultArray.push(line)
            }
        }

        if (resultArray.length == 0) {
            return '';
        }

        let maxLine = resultArray[0];
        let maxLength = maxLine.split('\t')[this.annoStream.headings.indexOf('transcript_length')]
        for (var i in resultArray) {
            let line = resultArray[i];
            let lineData = line.split('\t');
            let length = lineData[this.annoStream.headings.indexOf('transcript_length')];
            let transciptID = lineData[this.annoStream.headings.indexOf('Feature')];
            let MANE_TR = lineData[this.annoStream.headings.indexOf('MANE_TR')];
            if (transciptID.indexOf(MANE_TR + '.') == 0) {
                return line
            }
            if (length - maxLength > 0) {
                maxLine = line;
                maxLength = length;
            }
        }
        return maxLine;
    }
}
