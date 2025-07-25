import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AnnovarService {
    private readonly logger = new Logger(AnnovarService.name)
    
    constructor(
        private configService: ConfigService
    ) {}

    async runVEP(input: string, output: string) {
        let start = Date.now()

        console.log('Run VEP: ' + start)
        this.logger.log(`Running VEP with input: ${input} and output: ${output}`);

        console.log(`Vep completed. Duration: ${(Date.now() - start) / 1000} seconds.`)
    }
}
