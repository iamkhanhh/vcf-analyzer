import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CommonService {
    private readonly logger = new Logger(CommonService.name)

    constructor(
        private configService: ConfigService
    ) {}
}
