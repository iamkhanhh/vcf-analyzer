import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisModel } from 'src/models/analysis.model';

@Injectable()
export class VcfService {
    private readonly logger = new Logger(VcfService.name)

    constructor(
        private configService: ConfigService
    ) {}
}
