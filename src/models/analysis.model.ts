import { UploadModel } from "./upload.model";

export class AnalysisModel {
    id: number;
    
    name: string;

    user_id: number;

    data_type: string;

    control: string;

    genotype: string;

    igv_local_path: string;

    sample_id: number;

    project_id: number;

    p_type: string;

    analyzed: Date;

    variants: number;

    size: number;

    status: number;

    variants_to_report: string;

    file_path: string;

    description: string;

    is_deleted: number;

    pipeline_id: number;

    upload_id: number;

    assembly: string;

    sequencing_type: string;

    upload: UploadModel;

    createdAt: Date;

    updatedAt: Date;
}

export enum AnalysisStatus {
    QUEUING = 0,
    ANALYZING = 1, 
    ANALYZED = 2,
    ERROR = 3,
    VEP_ANALYZED = 4,
    IMPORTING = 5,
    FASTQ_QUEUING = 6,
    FASTQ_ANALYZING = 7,
    FASTQ_ERROR = 8,
}