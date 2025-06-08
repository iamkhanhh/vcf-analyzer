import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AnnovarService {
    private readonly logger = new Logger(AnnovarService.name)
    
    constructor(
        private configService: ConfigService
    ) {}
}
