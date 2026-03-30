import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { AnnovarService } from './services/annovar.service';
import { VcfService } from './services/vcf.service';
import { CommonService } from './services/common.service';
import { GlobalService } from './services/global.service';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { CommunicationService } from './services/communication.service';
import { CalculateService } from './services/calculate.service';

@Module({
  imports: [
    ConfigModule.forRoot({ 
      isGlobal: true,
      expandVariables: true,
    }),
    ScheduleModule.forRoot(),
    HttpModule
  ],
  controllers: [AppController],
  providers: [AppService, AnnovarService, VcfService, CommonService, GlobalService, CommunicationService, CalculateService],
})
export class AppModule {}
