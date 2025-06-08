import { Injectable } from '@nestjs/common';

@Injectable()
export class GlobalService {
    private isInstanceAnalyzing: boolean

    constructor() {
        this.isInstanceAnalyzing = false;
    }

    get isAnalyzing() {
        return this.isInstanceAnalyzing;
    }

    set isAnalyzing(isAnalyzing: boolean) {
        this.isInstanceAnalyzing = isAnalyzing;
    }
}
