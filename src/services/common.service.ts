import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { AnalysisModel } from 'src/models/analysis.model';

@Injectable()
export class CommonService {
    private readonly logger = new Logger(CommonService.name)

    constructor(
        private configService: ConfigService
    ) { }

    async runCommand(command: string): Promise<string> {
        console.log(`Running command: ${command}`);

        return await new Promise((resolve, reject) => {
            exec(command, { maxBuffer: 1024 * 500 }, (error, stdout, stderr) => {
                if (error) {
                    this.logger.error(stderr);
                    return reject(error)
                } else {
                    return resolve(stdout);
                }
            });
        })
    }

    escapeFileName(name) {
        let options = [
            [/"/g, '\\"'],
            [/\s/g, '\\ '],
            [/\(/g, '\\('],
            [/\)/g, '\\)']
        ]

        for (var key in options) {
            name = name.replace(options[key][0], options[key][1])
        }

        return name
    }

    getAnalysisFolder(analysis: AnalysisModel) {
        return `${this.configService.get('ANALYSIS_FOLDER')}/${analysis.user_id}/${analysis.id}`
    }
}
