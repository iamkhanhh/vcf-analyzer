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

    
}
