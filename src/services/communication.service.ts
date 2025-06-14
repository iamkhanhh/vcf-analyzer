import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { catchError, firstValueFrom } from 'rxjs';
import { AnalysisModel, AnalysisStatus } from 'src/models/analysis.model';

interface PendingAnalysisResponse {
    status: string;
    message?: string;
    data: AnalysisModel;
}

@Injectable()
export class CommunicationService {
    hostUrl: string;
    private readonly logger = new Logger(CommunicationService.name)

    constructor(
        private readonly configService: ConfigService,
        private readonly httpService: HttpService
    ) {
        this.hostUrl = this.configService.get<string>('HOST_URL', 'http://localhost:3000');
    }

    async getPendingAnalysis(): Promise<AnalysisModel> {
        const { data } = await firstValueFrom(
            this.httpService.get<PendingAnalysisResponse>(`${this.hostUrl}/get-pending-analysis`, {
                headers: {
                    Authorization: `Bearer ${this.configService.get<string>('VEP_TOKEN')}`,
                }
            }).pipe(
                catchError((error: AxiosError) => {
                    const errorData = error.response?.data as { message?: string };
                    this.logger.error(errorData.message);
                    throw 'An error happened!';
                }),
            ),
        );

        if (data && data.status != 'success') {
            this.logger.error(`Error fetching pending analysis: ${data.message || 'Unknown error'}`);
            throw new Error(data.message || 'Failed to fetch pending analysis');
        }

        return data.data;
    }

    async updateAnalysisStatus(analysisId: number, status: AnalysisStatus): Promise<void> {
        try {
            const { data } = await firstValueFrom(
                this.httpService.put(`${this.hostUrl}/update-analysis-status`, {
                    analysisId,
                    status
                }, {
                    headers: {
                        Authorization: `Bearer ${this.configService.get<string>('VEP_TOKEN')}`,
                    }
                }).pipe(
                    catchError((error: AxiosError) => {
                        const errorData = error.response?.data as { message?: string };
                        this.logger.error(errorData.message);
                        throw 'An error happened!';
                    }),
                ),
            );

            if (data && data.status != 'success') {
                this.logger.error(`Error updating analysis status: ${data.message || 'Unknown error'}`);
                throw new Error(data.message || 'Failed to update analysis status');
            }
        } catch (error) {
            this.logger.error(`CommunicationService@updateAnalysisStatus: ${error}`);
            throw error;
        }
    }
}
